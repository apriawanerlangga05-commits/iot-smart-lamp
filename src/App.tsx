import { useEffect, useRef, useState, useCallback } from 'react';
import mqtt, { MqttClient } from 'mqtt';
import {
  Thermometer, Droplets, Power, Play, Square,
  Loader2, AlertTriangle, Home, Mic, MicOff, Trash2
} from 'lucide-react';

// ─── MQTT Topics ──────────────────────────────────────────────────────────────
const TOPICS = {
  STATUS_RELAY: 'iot/rumah2/relay/status',
  CMD_RELAY: 'iot/rumah2/relay/command',
  DATA_SENSOR: 'iot/rumah2/sensor/data',
  STATUS_VAR: 'iot/rumah2/variasi/status',
  CMD_VAR: 'iot/rumah2/variasi/command',
  CMD_ALL: 'iot/rumah2/relay/allcommand'
};

// ─── Types ────────────────────────────────────────────────────────────────────
type RelayState = Record<number, boolean>;
type LogType = 'on' | 'off' | 'info' | 'warn' | 'voice' | 'err';
type LogSource = 'web' | 'voice' | 'auto' | 'sys';
interface LogEntry { time: string; msg: string; type: LogType; source: LogSource; }
type VoiceResultType = 'ok' | 'err' | 'unk' | null;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function numWord(w: string): number {
  const map: Record<string, number> = { satu: 1, dua: 2, tiga: 3, empat: 4, one: 1, two: 2, three: 3, four: 4 };
  return map[w] ?? parseInt(w);
}

function nowTime(): string {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => n.toString().padStart(2, '0')).join(':');
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function App() {
  // MQTT
  const [client, setClient] = useState<MqttClient | null>(null);
  const [connected, setConnected] = useState(false);
  const [relays, setRelays] = useState<RelayState>({ 1: false, 2: false, 3: false, 4: false });
  const [sensor, setSensor] = useState({ suhu: '--', kelembaban: '--', lastUpdate: '--:--:--' });
  const [variasi, setVariasi] = useState(0);
  const [loadingRelays, setLoadingRelays] = useState<Record<number, boolean>>({});

  // Voice
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [voiceResult, setVoiceResult] = useState<{ type: VoiceResultType; msg: string } | null>(null);
  const recognitionRef = useRef<any>(null);
  const voiceResultTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Log
  const [logs, setLogs] = useState<LogEntry[]>([]);

  // Refs for voice command closures
  const relaysRef = useRef(relays);
  const variasiRef = useRef(variasi);
  const clientRef = useRef(client);
  const connectedRef = useRef(connected);

  useEffect(() => { relaysRef.current = relays; }, [relays]);
  useEffect(() => { variasiRef.current = variasi; }, [variasi]);
  useEffect(() => { clientRef.current = client; }, [client]);
  useEffect(() => { connectedRef.current = connected; }, [connected]);

  // ── Log helper ──────────────────────────────────────────────────────────────
  const addLog = useCallback((msg: string, type: LogType = 'info', source: LogSource = 'sys') => {
    setLogs(prev => [{ time: nowTime(), msg, type, source }, ...prev].slice(0, 100));
  }, []);

  // ── MQTT setup ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const clientId = `web_${Math.random().toString(16).slice(2, 10)}`;
    const mqttClient = mqtt.connect('wss://broker.hivemq.com:8884/mqtt', {
      clientId, keepalive: 60, protocolVersion: 4,
      clean: true, reconnectPeriod: 2000, connectTimeout: 30000,
    });

    setClient(mqttClient);

    mqttClient.on('connect', () => {
      setConnected(true);
      mqttClient.subscribe([TOPICS.STATUS_RELAY, TOPICS.DATA_SENSOR, TOPICS.STATUS_VAR]);
      setLoadingRelays({});
      addLog('Terhubung ke broker MQTT', 'info', 'sys');
    });

    mqttClient.on('reconnect', () => { setConnected(false); addLog('Mencoba menghubungkan ulang...', 'warn', 'sys'); });
    mqttClient.on('offline', () => { setConnected(false); addLog('Koneksi terputus', 'err', 'sys'); });
    mqttClient.on('error', (err) => addLog(`Error MQTT: ${err.message}`, 'err', 'sys'));

    mqttClient.on('message', (topic, message) => {
      try {
        const payload = JSON.parse(message.toString());
        switch (topic) {
          case TOPICS.STATUS_RELAY:
            setRelays({ 1: payload.relay1 || false, 2: payload.relay2 || false, 3: payload.relay3 || false, 4: payload.relay4 || false });
            setLoadingRelays({});
            break;
          case TOPICS.DATA_SENSOR:
            setSensor({ suhu: payload.suhu ?? '--', kelembaban: payload.kelembaban ?? '--', lastUpdate: nowTime() });
            break;
          case TOPICS.STATUS_VAR:
            setVariasi(payload.variasi || 0);
            break;
        }
      } catch (e) { console.error('Invalid JSON:', e); }
    });

    return () => { mqttClient.end(); };
  }, [addLog]);

  // ── Relay actions ───────────────────────────────────────────────────────────
  const toggleRelay = (id: number) => {
    if (!client || !connected || variasi > 0) return;
    setLoadingRelays(prev => ({ ...prev, [id]: true }));
    const newState = !relays[id];
    client.publish(TOPICS.CMD_RELAY, JSON.stringify({ relay: id, state: newState }));
    addLog(`Lampu ${id} ${newState ? 'dinyalakan' : 'dimatikan'}`, newState ? 'on' : 'off', 'web');
    setTimeout(() => {
      setLoadingRelays(prev => { const next = { ...prev }; delete next[id]; return next; });
    }, 4000);
  };

  const setAllRelays = (state: boolean) => {
    if (!client || !connected || variasi > 0) return;
    client.publish(TOPICS.CMD_ALL, JSON.stringify({ state }));
    addLog(`Semua lampu ${state ? 'dinyalakan' : 'dimatikan'}`, state ? 'on' : 'off', 'web');
  };

  const setVariation = (id: number) => {
    if (!client || !connected) return;
    client.publish(TOPICS.CMD_VAR, JSON.stringify({ variasi: id }));
    if (id === 0) addLog('Variasi dihentikan', 'off', 'web');
    else addLog(`Variasi ${id} diaktifkan`, 'on', 'web');
  };

  // ── Voice result display ─────────────────────────────────────────────────────
  const showVoiceResult = (type: VoiceResultType, msg: string) => {
    setVoiceResult({ type, msg });
    if (voiceResultTimer.current) clearTimeout(voiceResultTimer.current);
    voiceResultTimer.current = setTimeout(() => setVoiceResult(null), 5000);
  };

  // ── Voice command processor ─────────────────────────────────────────────────
  const processVoiceCommand = useCallback((text: string) => {
    const t = text.toLowerCase().trim();
    addLog(`Voice: "${text}"`, 'voice', 'voice');

    const cl = clientRef.current;
    const conn = connectedRef.current;
    const var_ = variasiRef.current;

    if (!cl || !conn) { showVoiceResult('err', 'Tidak terhubung ke broker'); return; }

    // Semua ON
    if (/(nyala|hidupkan|on)\s*(semua|all)/.test(t) || /(semua|all).*(nyala|on)/.test(t)) {
      if (var_ > 0) { showVoiceResult('err', 'Variasi aktif – kontrol manual dinonaktifkan'); return; }
      cl.publish(TOPICS.CMD_ALL, JSON.stringify({ state: true }));
      showVoiceResult('ok', '✓ Semua lampu dinyalakan');
      addLog('Voice → Semua lampu dinyalakan', 'on', 'voice'); return;
    }

    // Semua OFF
    if (/(mati(kan)?|off)\s*(semua|all)/.test(t) || /(semua|all).*(mati|off)/.test(t)) {
      if (var_ > 0) { showVoiceResult('err', 'Variasi aktif – kontrol manual dinonaktifkan'); return; }
      cl.publish(TOPICS.CMD_ALL, JSON.stringify({ state: false }));
      showVoiceResult('ok', '✓ Semua lampu dimatikan');
      addLog('Voice → Semua lampu dimatikan', 'off', 'voice'); return;
    }

    // Stop variasi
    if (/(stop|henti(kan)?|berhenti)\s*(variasi)?/.test(t) || /variasi.*(stop|off|mati|berhenti)/.test(t)) {
      cl.publish(TOPICS.CMD_VAR, JSON.stringify({ variasi: 0 }));
      showVoiceResult('ok', '✓ Variasi dihentikan');
      addLog('Voice → Stop variasi', 'off', 'voice'); return;
    }

    // Variasi 1 / 2
    const varM = t.match(/variasi\s*(satu|1|dua|2|one|two)/);
    if (varM) {
      const n = /satu|1|one/.test(varM[1]) ? 1 : 2;
      cl.publish(TOPICS.CMD_VAR, JSON.stringify({ variasi: n }));
      showVoiceResult('ok', `✓ Variasi ${n} diaktifkan`);
      addLog(`Voice → Variasi ${n}`, 'on', 'voice'); return;
    }

    // Lampu ON individual
    const onM = t.match(/(nyala(kan)?|hidupkan|on|aktif(kan)?)\s*(lampu\s*)?(satu|1|dua|2|tiga|3|empat|4|one|two|three|four)/);
    if (onM) {
      const id = numWord(onM[5]);
      if (var_ > 0) { showVoiceResult('err', 'Variasi aktif – kontrol manual dinonaktifkan'); return; }
      cl.publish(TOPICS.CMD_RELAY, JSON.stringify({ relay: id, state: true }));
      showVoiceResult('ok', `✓ Lampu ${id} dinyalakan`);
      addLog(`Voice → Lampu ${id} dinyalakan`, 'on', 'voice'); return;
    }

    // Lampu OFF individual
    const offM = t.match(/(matikan|mati(kan)?|off)\s*(lampu\s*)?(satu|1|dua|2|tiga|3|empat|4|one|two|three|four)/);
    if (offM) {
      const id = numWord(offM[4]);
      if (var_ > 0) { showVoiceResult('err', 'Variasi aktif – kontrol manual dinonaktifkan'); return; }
      cl.publish(TOPICS.CMD_RELAY, JSON.stringify({ relay: id, state: false }));
      showVoiceResult('ok', `✓ Lampu ${id} dimatikan`);
      addLog(`Voice → Lampu ${id} dimatikan`, 'off', 'voice'); return;
    }

    showVoiceResult('unk', `Tidak dikenali: "${text}"`);
    addLog(`Voice tidak dikenali: "${text}"`, 'warn', 'voice');
  }, [addLog]);

  // ── Mic toggle ──────────────────────────────────────────────────────────────
  const toggleMic = () => {
    if (isListening) {
      recognitionRef.current?.stop();
      return;
    }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      showVoiceResult('err', 'Browser tidak mendukung Speech Recognition (gunakan Chrome)');
      addLog('Speech Recognition tidak didukung browser ini', 'err', 'voice');
      return;
    }

    const rec = new SR();
    rec.lang = 'id-ID';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    recognitionRef.current = rec;

    let finalText = '';

    rec.onstart = () => {
      setIsListening(true);
      setTranscript('🎙 Mendengarkan...');
      setVoiceResult(null);
    };

    rec.onresult = (e: any) => {
      finalText = Array.from(e.results as any[]).map((r: any) => r[0].transcript).join('');
      setTranscript(finalText);
    };

    rec.onend = () => {
      setIsListening(false);
      setTranscript('');
      if (finalText) processVoiceCommand(finalText);
    };

    rec.onerror = (e: any) => {
      setIsListening(false);
      setTranscript('');
      showVoiceResult('err', `Error: ${e.error}`);
      addLog(`Voice error: ${e.error}`, 'err', 'voice');
    };

    rec.start();
  };

  const isHighTemp = parseFloat(sensor.suhu) >= 35.0;
  const isVariationActive = variasi > 0;

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{
      minHeight: '100vh', background: '#080810', color: '#e8e6ff',
      fontFamily: "'Syne', sans-serif", overflowX: 'hidden', position: 'relative',
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=DM+Mono:wght@300;400;500&display=swap');

        :root {
          --accent: #6D5EF5;
          --accent-dim: rgba(109,94,245,0.15);
          --accent-glow: rgba(109,94,245,0.35);
          --bg: #080810;
          --bg2: #0e0e1a;
          --bg3: #13131f;
          --border: rgba(255,255,255,0.07);
          --border-accent: rgba(109,94,245,0.3);
          --text: #e8e6ff;
          --muted: #4a4870;
          --muted2: #2a2845;
          --success: #3dd68c;
          --danger: #ff5f7e;
          --warn: #f5a623;
        }

        * { box-sizing: border-box; }

        .bg-grid::before {
          content: '';
          position: fixed; inset: 0;
          background-image:
            linear-gradient(rgba(109,94,245,0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(109,94,245,0.03) 1px, transparent 1px);
          background-size: 40px 40px;
          pointer-events: none; z-index: 0;
        }

        .mono { font-family: 'DM Mono', monospace; }

        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.35} }
        @keyframes micPulse {
          0%,100% { box-shadow: 0 0 0 0 rgba(255,95,126,.3); }
          50% { box-shadow: 0 0 0 14px rgba(255,95,126,0); }
        }
        @keyframes relayGlow {
          0%,100% { box-shadow: 0 0 6px rgba(109,94,245,0.6); }
          50% { box-shadow: 0 0 16px rgba(109,94,245,1), 0 0 30px rgba(109,94,245,0.4); }
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes logIn {
          from { opacity: 0; transform: translateY(-6px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .dot-blink { animation: blink 2s ease infinite; }
        .mic-pulse { animation: micPulse 1.4s ease infinite; }
        .led-glow { animation: relayGlow 2s ease-in-out infinite; }
        .spinner { width:14px; height:14px; border:2px solid currentColor; border-top-color:transparent; border-radius:50%; animation: spin .7s linear infinite; }

        .card-hover { transition: border-color .2s, box-shadow .2s; }
        .card-hover:hover { border-color: var(--border-accent) !important; }

        .log-scroll { max-height: 260px; overflow-y: auto; }
        .log-scroll::-webkit-scrollbar { width: 4px; }
        .log-scroll::-webkit-scrollbar-track { background: transparent; }
        .log-scroll::-webkit-scrollbar-thumb { background: var(--muted2); border-radius: 4px; }

        .log-row { animation: logIn .25s ease; }

        button { cursor: pointer; }
        button:disabled { opacity: .3; cursor: not-allowed !important; }
      `}</style>

      {/* BG Grid */}
      <div className="bg-grid" style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0 }} />

      <div style={{ maxWidth: 900, margin: '0 auto', padding: '28px 16px 60px', position: 'relative', zIndex: 1 }}>

        {/* ── HEADER ── */}
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28, flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 38, height: 38, background: 'var(--accent-dim)', border: '1px solid var(--border-accent)', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Home size={18} color="var(--accent)" />
            </div>
            <div>
              <h1 style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em', margin: 0 }}>Smart Home</h1>
              <p className="mono" style={{ fontSize: 11, color: 'var(--muted)', margin: 0 }}>iot/rumah2 · HiveMQ</p>
            </div>
          </div>

          {/* Status badge */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 12px', borderRadius: 20,
            fontSize: 11, fontWeight: 500, border: '1px solid',
            ...(connected
              ? { background: 'rgba(61,214,140,0.08)', borderColor: 'rgba(61,214,140,0.2)', color: 'var(--success)' }
              : { background: 'rgba(255,95,126,0.08)', borderColor: 'rgba(255,95,126,0.2)', color: 'var(--danger)' })
          }} className="mono">
            <div className={connected ? 'dot-blink' : ''} style={{
              width: 7, height: 7, borderRadius: '50%',
              background: connected ? 'var(--success)' : 'var(--danger)'
            }} />
            {connected ? 'Online' : 'Offline'}
          </div>
        </header>

        {/* ── TOP GRID: Sensor + Voice ── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14, marginBottom: 14 }}>

          {/* SENSOR */}
          <div className="card-hover" style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 16, padding: 20 }}>
            <div className="mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Thermometer size={13} color="var(--accent)" />
              Sensor DHT11
            </div>
            <div style={{ display: 'flex', gap: 24 }}>
              {/* Suhu */}
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 42, fontWeight: 800, lineHeight: 1, letterSpacing: '-0.04em', color: isHighTemp ? 'var(--danger)' : 'var(--text)' }}>
                  {sensor.suhu}<span style={{ fontSize: 16, color: 'var(--muted)', marginLeft: 3 }}>°C</span>
                </div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>Suhu</div>
                {isHighTemp && (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'rgba(255,95,126,0.1)', border: '1px solid rgba(255,95,126,0.25)', color: 'var(--danger)', fontSize: 10, padding: '2px 8px', borderRadius: 4, marginTop: 4 }} className="mono">
                    <AlertTriangle size={10} /> PANAS
                  </div>
                )}
              </div>
              <div style={{ width: 1, background: 'var(--border)' }} />
              {/* Kelembaban */}
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 42, fontWeight: 800, lineHeight: 1, letterSpacing: '-0.04em', color: 'var(--text)' }}>
                  {sensor.kelembaban}<span style={{ fontSize: 16, color: 'var(--muted)', marginLeft: 3 }}>%</span>
                </div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>Kelembaban</div>
              </div>
            </div>
            <div className="mono" style={{ marginTop: 14, fontSize: 10, color: 'var(--muted)' }}>
              Update: {sensor.lastUpdate}
            </div>
          </div>

          {/* VOICE */}
          <div style={{
            background: 'var(--bg2)', borderRadius: 16, padding: 20,
            border: isListening ? '1px solid rgba(255,95,126,0.5)' : '1px solid var(--border)',
            transition: 'border-color .3s',
          }}>
            <div className="mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Mic size={13} color="var(--accent)" />
              Perintah Suara
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              {/* Mic button */}
              <button
                onClick={toggleMic}
                style={{
                  width: 64, height: 64, borderRadius: '50%', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: isListening ? 'rgba(255,95,126,0.1)' : 'var(--bg3)',
                  border: isListening ? '1px solid rgba(255,95,126,.5)' : '1px solid var(--border)',
                  transition: 'all .2s',
                }}
                className={isListening ? 'mic-pulse' : ''}
                title="Tekan untuk berbicara"
              >
                {isListening
                  ? <MicOff size={26} color="#ff5f7e" />
                  : <Mic size={26} color="var(--accent)" />
                }
              </button>

              {/* Transcript + result */}
              <div style={{ flex: 1 }}>
                <div className="mono" style={{ fontSize: 13, color: transcript ? 'var(--text)' : 'var(--muted)', minHeight: 20, marginBottom: 8 }}>
                  {transcript || 'Tekan mic untuk mulai...'}
                </div>
                {voiceResult && (
                  <div className="mono" style={{
                    fontSize: 12, padding: '7px 12px', borderRadius: 8,
                    ...(voiceResult.type === 'ok'
                      ? { background: 'rgba(61,214,140,0.08)', border: '1px solid rgba(61,214,140,0.2)', color: 'var(--success)' }
                      : voiceResult.type === 'err'
                      ? { background: 'rgba(255,95,126,0.08)', border: '1px solid rgba(255,95,126,0.2)', color: 'var(--danger)' }
                      : { background: 'rgba(245,166,35,0.08)', border: '1px solid rgba(245,166,35,0.2)', color: 'var(--warn)' })
                  }}>
                    {voiceResult.msg}
                  </div>
                )}
              </div>
            </div>

            {/* Hints */}
            <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {['"nyalakan lampu 1"', '"matikan semua"', '"variasi dua"', '"stop variasi"', '"nyalakan semua"'].map(h => (
                <span key={h} className="mono" style={{ fontSize: 10, padding: '3px 8px', borderRadius: 4, background: 'var(--muted2)', color: 'var(--muted)', border: '1px solid rgba(255,255,255,0.05)' }}>
                  {h}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* ── RELAY SECTION ── */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
            <div className="mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Power size={13} color="var(--accent)" />
              Kontrol Lampu
              {isVariationActive && (
                <span className="mono" style={{ fontSize: 9, padding: '2px 8px', borderRadius: 4, background: 'rgba(109,94,245,0.15)', border: '1px solid rgba(109,94,245,0.3)', color: 'var(--accent)', letterSpacing: '.05em' }}>
                  VARIASI AKTIF
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {[{ label: 'Semua ON', state: true }, { label: 'Semua OFF', state: false }].map(({ label, state }) => (
                <button
                  key={label}
                  onClick={() => setAllRelays(state)}
                  disabled={!connected || isVariationActive}
                  style={{ fontFamily: "'Syne', sans-serif", fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg3)', color: 'var(--muted)', transition: 'all .15s' }}
                  onMouseEnter={e => { if (connected && !isVariationActive) { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(109,94,245,.4)'; (e.currentTarget as HTMLElement).style.color = 'var(--text)'; } }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLElement).style.color = 'var(--muted)'; }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Relay grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
            {[1, 2, 3, 4].map((id) => {
              const isON = relays[id];
              const isLoading = loadingRelays[id];
              return (
                <div
                  key={id}
                  className="card-hover"
                  style={{
                    background: 'var(--bg3)', borderRadius: 14, padding: 18,
                    display: 'flex', flexDirection: 'column', gap: 14,
                    border: isON ? '1px solid var(--border-accent)' : '1px solid var(--border)',
                    boxShadow: isON ? '0 0 28px rgba(109,94,245,0.08)' : 'none',
                    opacity: isVariationActive ? .5 : 1,
                    pointerEvents: isVariationActive ? 'none' : 'auto',
                    transition: 'border-color .2s, box-shadow .2s, opacity .2s',
                    position: 'relative', overflow: 'hidden',
                  }}
                >
                  {isON && <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'linear-gradient(135deg, rgba(109,94,245,0.04) 0%, transparent 60%)' }} />}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>Lampu {id}</span>
                    <div
                      className={isON ? 'led-glow' : ''}
                      style={{ width: 11, height: 11, borderRadius: '50%', background: isON ? 'var(--accent)' : 'var(--muted2)', transition: 'all .3s' }}
                    />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span className="mono" style={{ fontSize: 10, padding: '3px 8px', borderRadius: 4, letterSpacing: '.05em', ...(isON ? { background: 'var(--accent-dim)', color: 'var(--accent)', border: '1px solid var(--border-accent)' } : { background: 'var(--muted2)', color: 'var(--muted)', border: '1px solid rgba(255,255,255,0.05)' }) }}>
                      {isON ? 'MENYALA' : 'MATI'}
                    </span>
                    <button
                      onClick={() => toggleRelay(id)}
                      disabled={!connected || isVariationActive || isLoading}
                      style={{
                        fontFamily: "'Syne', sans-serif", fontSize: 13, fontWeight: 700,
                        padding: '11px 16px', borderRadius: 10, border: 'none',
                        display: 'flex', alignItems: 'center', gap: 8,
                        transition: 'all .15s',
                        ...(isON
                          ? { background: 'var(--accent-dim)', color: 'var(--accent)', border: '1px solid var(--border-accent)' }
                          : { background: 'var(--accent)', color: '#fff', boxShadow: '0 4px 20px rgba(109,94,245,0.35)' })
                      }}
                    >
                      {isLoading ? <div className="spinner" /> : <Power size={14} />}
                      {isON ? 'Matikan' : 'Nyalakan'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── VARIATION ── */}
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 16, padding: 20, marginBottom: 14 }} className="card-hover">
          <div className="mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Play size={13} color="var(--accent)" />
            Variasi Lampu
          </div>
          <p className="mono" style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 16, lineHeight: 1.6 }}>
            Mode otomatis. Kontrol manual dinonaktifkan saat variasi berjalan.
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {[1, 2].map((v) => (
              <button
                key={v}
                onClick={() => setVariation(v)}
                disabled={!connected}
                style={{
                  flex: 1, minWidth: 120, padding: '13px 16px', borderRadius: 12,
                  fontFamily: "'Syne', sans-serif", fontSize: 13, fontWeight: 600,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  transition: 'all .15s',
                  ...(variasi === v
                    ? { background: 'var(--accent-dim)', border: '1px solid var(--border-accent)', color: 'var(--accent)', boxShadow: '0 0 20px rgba(109,94,245,.12)' }
                    : { background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--muted)' })
                }}
              >
                <Play size={14} fill={variasi === v ? 'currentColor' : 'none'} />
                Variasi {v}
              </button>
            ))}
            <button
              onClick={() => setVariation(0)}
              disabled={!connected || variasi === 0}
              style={{
                flex: 1, minWidth: 120, padding: '13px 16px', borderRadius: 12,
                fontFamily: "'Syne', sans-serif", fontSize: 13, fontWeight: 600,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                transition: 'all .15s',
                ...(variasi !== 0
                  ? { background: 'rgba(255,95,126,.08)', border: '1px solid rgba(255,95,126,.3)', color: 'var(--danger)' }
                  : { background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--muted2)' })
              }}
            >
              <Square size={12} fill="currentColor" />
              Stop Variasi
            </button>
          </div>
        </div>

        {/* ── ACTIVITY LOG ── */}
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="mono" style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)' }}>Aktivitas</span>
              <span className="mono" style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: 'var(--accent-dim)', color: 'var(--accent)', border: '1px solid var(--border-accent)' }}>
                {logs.length}
              </span>
            </div>
            <button
              onClick={() => setLogs([])}
              style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: 'var(--muted)', background: 'none', border: 'none', transition: 'color .15s', display: 'flex', alignItems: 'center', gap: 4 }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.color = 'var(--danger)'}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.color = 'var(--muted)'}
            >
              <Trash2 size={12} /> Hapus
            </button>
          </div>

          <div className="log-scroll">
            {logs.length === 0 ? (
              <div className="mono" style={{ padding: 32, textAlign: 'center', fontSize: 12, color: 'var(--muted2)' }}>Belum ada aktivitas...</div>
            ) : logs.map((l, i) => (
              <div key={i} className="log-row" style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '9px 18px', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                <span className="mono" style={{ fontSize: 10, color: 'var(--muted)', whiteSpace: 'nowrap', paddingTop: 1, minWidth: 60 }}>{l.time}</span>
                <div style={{
                  width: 7, height: 7, borderRadius: '50%', flexShrink: 0, marginTop: 5,
                  background: l.type === 'on' ? 'var(--accent)' : l.type === 'off' ? 'var(--muted)' : l.type === 'voice' ? '#ff5f7e' : l.type === 'err' ? 'var(--danger)' : l.type === 'warn' ? 'var(--warn)' : 'var(--success)',
                }} />
                <span style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.4, flex: 1 }}>
                  {l.msg}
                  <span className="mono" style={{
                    fontSize: 9, fontWeight: 500, padding: '2px 6px', borderRadius: 3, letterSpacing: '.05em', marginLeft: 6, verticalAlign: 'middle',
                    ...(l.source === 'web' ? { background: 'var(--accent-dim)', color: 'var(--accent)' } : l.source === 'voice' ? { background: 'rgba(255,95,126,0.1)', color: 'var(--danger)' } : { background: 'var(--muted2)', color: 'var(--muted)' })
                  }}>
                    {l.source.toUpperCase()}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
