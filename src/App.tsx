import { useEffect, useRef, useState, useCallback } from 'react';
import mqtt, { MqttClient } from 'mqtt';
import { Power, Play, Square, AlertTriangle, Home, Mic, MicOff, Trash2, Zap, Shuffle } from 'lucide-react';

// ─── MQTT Topics ──────────────────────────────────────────────────────────────
const TOPICS = {
  STATUS_RELAY: 'iot/rumah2/relay/status',
  CMD_RELAY:    'iot/rumah2/relay/command',
  DATA_SENSOR:  'iot/rumah2/sensor/data',
  STATUS_VAR:   'iot/rumah2/variasi/status',
  CMD_VAR:      'iot/rumah2/variasi/command',
  CMD_ALL:      'iot/rumah2/relay/allcommand',
};

// ─── Types ────────────────────────────────────────────────────────────────────
type RelayState = Record<number, boolean>;
type LogType    = 'on' | 'off' | 'info' | 'warn' | 'voice' | 'err';
type LogSource  = 'web' | 'voice' | 'auto' | 'sys';
interface LogEntry { time: string; msg: string; type: LogType; source: LogSource; }
type VoiceResultType = 'ok' | 'err' | 'unk' | null;

const RELAY_IDS = [1, 2, 3, 4] as const;

// ─── Variation sequences ──────────────────────────────────────────────────────
// Variasi 1: bolak-balik ujung ke ujung  1→2→3→4→3→2→1
const VAR1_SEQ = [1, 2, 3, 4, 3, 2, 1];
// Variasi 2: nyala satu per satu 1→2→3→4 (akumulatif), lalu reset
const VAR2_STEPS = [
  { 1: true,  2: false, 3: false, 4: false },
  { 1: true,  2: true,  3: false, 4: false },
  { 1: true,  2: true,  3: true,  4: false },
  { 1: true,  2: true,  3: true,  4: true  },
  { 1: false, 2: false, 3: false, 4: false }, // reset
];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function numWord(w: string): number {
  const m: Record<string,number> = { satu:1, dua:2, tiga:3, empat:4, one:1, two:2, three:3, four:4 };
  return m[w] ?? parseInt(w);
}
function nowTime(): string {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2,'0')).join(':');
}
function allOff(): RelayState { return { 1:false, 2:false, 3:false, 4:false }; }

// ─── Component ────────────────────────────────────────────────────────────────
export default function App() {
  // MQTT
  const [client, setClient]           = useState<MqttClient | null>(null);
  const [connected, setConnected]     = useState(false);
  const [relays, setRelays]           = useState<RelayState>(allOff());
  const [sensor, setSensor]           = useState({ suhu:'--', kelembaban:'--', lastUpdate:'--:--:--' });
  const [variasi, setVariasi]         = useState(0);           // 0 = manual, 1/2/3 = variasi aktif

  // Voice
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript]   = useState('');
  const [voiceResult, setVoiceResult] = useState<{ type: VoiceResultType; msg: string } | null>(null);
  const recognitionRef   = useRef<any>(null);
  const voiceResultTimer = useRef<ReturnType<typeof setTimeout>|null>(null);

  // Log
  const [logs, setLogs] = useState<LogEntry[]>([]);

  // Variation timers
  const varTimerRef  = useRef<ReturnType<typeof setInterval>|null>(null);
  const varStepRef   = useRef(0);
  const varActiveRef = useRef(0); // mirrors variasi state for timer closures

  // Refs for closures
  const clientRef    = useRef(client);
  const connectedRef = useRef(connected);
  const variasiRef   = useRef(variasi);
  const relaysRef    = useRef(relays);

  useEffect(() => { clientRef.current    = client;    }, [client]);
  useEffect(() => { connectedRef.current = connected; }, [connected]);
  useEffect(() => { variasiRef.current   = variasi;   }, [variasi]);
  useEffect(() => { relaysRef.current    = relays;    }, [relays]);

  // ── Log ─────────────────────────────────────────────────────────────────────
  const addLog = useCallback((msg: string, type: LogType = 'info', source: LogSource = 'sys') => {
    setLogs(prev => [{ time: nowTime(), msg, type, source }, ...prev].slice(0, 100));
  }, []);

  // ── Publish relay state helper (also updates local state) ──────────────────
  const publishRelay = useCallback((id: number, state: boolean, source: LogSource = 'web') => {
    clientRef.current?.publish(TOPICS.CMD_RELAY, JSON.stringify({ relay: id, state }));
    setRelays(prev => ({ ...prev, [id]: state }));
    addLog(`Lampu ${id} ${state ? 'dinyalakan' : 'dimatikan'}`, state ? 'on' : 'off', source);
  }, [addLog]);

  const publishAll = useCallback((state: boolean, source: LogSource = 'web') => {
    clientRef.current?.publish(TOPICS.CMD_ALL, JSON.stringify({ state }));
    setRelays({ 1:state, 2:state, 3:state, 4:state });
    addLog(`Semua lampu ${state ? 'dinyalakan' : 'dimatikan'}`, state ? 'on' : 'off', source);
  }, [addLog]);

  // ── Stop variation timer ───────────────────────────────────────────────────
  const stopVarTimer = useCallback(() => {
    if (varTimerRef.current) { clearInterval(varTimerRef.current); varTimerRef.current = null; }
    varStepRef.current  = 0;
    varActiveRef.current = 0;
  }, []);

  // ── Start variation ────────────────────────────────────────────────────────
  const startVariation = useCallback((v: number) => {
    stopVarTimer();
    varActiveRef.current = v;
    varStepRef.current   = 0;

    if (v === 1) {
      // Bolak-balik: 1→2→3→4→3→2→1, hanya satu lampu menyala per step
      const step = () => {
        if (varActiveRef.current !== 1) return;
        const idx = varStepRef.current % VAR1_SEQ.length;
        const activeId = VAR1_SEQ[idx];
        const newState: RelayState = { 1:false, 2:false, 3:false, 4:false };
        newState[activeId] = true;
        setRelays(newState);
        clientRef.current?.publish(TOPICS.CMD_RELAY, JSON.stringify({ relay: activeId, state: true }));
        // turn off others
        RELAY_IDS.forEach(id => { if (id !== activeId) clientRef.current?.publish(TOPICS.CMD_RELAY, JSON.stringify({ relay: id, state: false })); });
        varStepRef.current++;
      };
      step();
      varTimerRef.current = setInterval(step, 500);

    } else if (v === 2) {
      // Akumulatif: nyala 1 demi 1 lalu reset
      const step = () => {
        if (varActiveRef.current !== 2) return;
        const idx = varStepRef.current % VAR2_STEPS.length;
        const snap = VAR2_STEPS[idx] as RelayState;
        setRelays({ ...snap });
        RELAY_IDS.forEach(id => {
          clientRef.current?.publish(TOPICS.CMD_RELAY, JSON.stringify({ relay: id, state: snap[id] }));
        });
        varStepRef.current++;
      };
      step();
      varTimerRef.current = setInterval(step, 600);

    } else if (v === 3) {
      // Bebas: kedip acak
      const step = () => {
        if (varActiveRef.current !== 3) return;
        const newState: RelayState = { 1:false, 2:false, 3:false, 4:false };
        RELAY_IDS.forEach(id => { newState[id] = Math.random() > 0.5; });
        setRelays(newState);
        RELAY_IDS.forEach(id => {
          clientRef.current?.publish(TOPICS.CMD_RELAY, JSON.stringify({ relay: id, state: newState[id] }));
        });
      };
      step();
      varTimerRef.current = setInterval(step, 400);
    }
  }, [stopVarTimer]);

  // ── Set variasi (publish + start local timer) ──────────────────────────────
  const setVariation = useCallback((v: number) => {
    if (!clientRef.current || !connectedRef.current) return;
    clientRef.current.publish(TOPICS.CMD_VAR, JSON.stringify({ variasi: v }));
    setVariasi(v);
    if (v === 0) {
      stopVarTimer();
      publishAll(false, 'web');
      addLog('Variasi dihentikan', 'off', 'web');
    } else {
      startVariation(v);
      addLog(`Variasi ${v} diaktifkan`, 'on', 'web');
    }
  }, [stopVarTimer, startVariation, publishAll, addLog]);

  // Sync varActiveRef when variasi state changes (e.g. from MQTT)
  useEffect(() => {
    varActiveRef.current = variasi;
    if (variasi > 0) startVariation(variasi);
    else stopVarTimer();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variasi]);

  // ── MQTT setup ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const mqttClient = mqtt.connect('wss://broker.hivemq.com:8884/mqtt', {
      clientId: `web_${Math.random().toString(16).slice(2,10)}`,
      keepalive: 60, protocolVersion: 4, clean: true,
      reconnectPeriod: 2000, connectTimeout: 30000,
    });
    setClient(mqttClient);

    mqttClient.on('connect', () => {
      setConnected(true);
      mqttClient.subscribe([TOPICS.STATUS_RELAY, TOPICS.DATA_SENSOR, TOPICS.STATUS_VAR]);
      addLog('Terhubung ke broker MQTT', 'info', 'sys');
    });
    mqttClient.on('reconnect', () => { setConnected(false); addLog('Menghubungkan ulang...', 'warn', 'sys'); });
    mqttClient.on('offline',   () => { setConnected(false); addLog('Koneksi terputus', 'err', 'sys'); });
    mqttClient.on('error', err => addLog(`Error MQTT: ${err.message}`, 'err', 'sys'));

    mqttClient.on('message', (topic, message) => {
      try {
        const p = JSON.parse(message.toString());
        if (topic === TOPICS.STATUS_RELAY) {
          // Only update from MQTT if no local variation running
          if (varActiveRef.current === 0)
            setRelays({ 1: !!p.relay1, 2: !!p.relay2, 3: !!p.relay3, 4: !!p.relay4 });
        } else if (topic === TOPICS.DATA_SENSOR) {
          setSensor({ suhu: p.suhu ?? '--', kelembaban: p.kelembaban ?? '--', lastUpdate: nowTime() });
        } else if (topic === TOPICS.STATUS_VAR) {
          setVariasi(p.variasi || 0);
        }
      } catch { /* ignore */ }
    });

    return () => { mqttClient.end(); stopVarTimer(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Manual relay toggle (stops variasi first if active) ────────────────────
  const toggleRelay = useCallback((id: number) => {
    if (!clientRef.current || !connectedRef.current) return;
    if (variasiRef.current > 0) {
      // Stop variasi then toggle
      clientRef.current.publish(TOPICS.CMD_VAR, JSON.stringify({ variasi: 0 }));
      setVariasi(0);
      stopVarTimer();
      addLog('Variasi dihentikan (manual override)', 'off', 'web');
    }
    const newState = !relaysRef.current[id];
    publishRelay(id, newState, 'web');
  }, [stopVarTimer, publishRelay, addLog]);

  const handleSetAllRelays = useCallback((state: boolean) => {
    if (!clientRef.current || !connectedRef.current) return;
    if (variasiRef.current > 0) {
      clientRef.current.publish(TOPICS.CMD_VAR, JSON.stringify({ variasi: 0 }));
      setVariasi(0);
      stopVarTimer();
    }
    publishAll(state, 'web');
  }, [stopVarTimer, publishAll]);

  // ── Voice result ─────────────────────────────────────────────────────────────
  const showVoiceResult = useCallback((type: VoiceResultType, msg: string) => {
    setVoiceResult({ type, msg });
    if (voiceResultTimer.current) clearTimeout(voiceResultTimer.current);
    voiceResultTimer.current = setTimeout(() => setVoiceResult(null), 5000);
  }, []);

  // ── Voice processor ─────────────────────────────────────────────────────────
  const processVoiceCommand = useCallback((text: string) => {
    const t = text.toLowerCase().trim();
    addLog(`Voice: "${text}"`, 'voice', 'voice');

    if (!connectedRef.current) { showVoiceResult('err', 'Tidak terhubung ke broker'); return; }

    const stopVarIfNeeded = () => {
      if (variasiRef.current > 0) {
        clientRef.current?.publish(TOPICS.CMD_VAR, JSON.stringify({ variasi: 0 }));
        setVariasi(0);
        stopVarTimer();
        addLog('Variasi dihentikan (voice override)', 'off', 'voice');
      }
    };

    // Semua ON
    if (/(nyala|hidupkan|on)\s*(semua|all)/.test(t) || /(semua|all).*(nyala|on)/.test(t)) {
      stopVarIfNeeded();
      publishAll(true, 'voice');
      showVoiceResult('ok', '✓ Semua lampu dinyalakan'); return;
    }
    // Semua OFF
    if (/(mati(kan)?|off)\s*(semua|all)/.test(t) || /(semua|all).*(mati|off)/.test(t)) {
      stopVarIfNeeded();
      publishAll(false, 'voice');
      showVoiceResult('ok', '✓ Semua lampu dimatikan'); return;
    }
    // Stop variasi
    if (/(stop|henti(kan)?|berhenti)\s*(variasi)?/.test(t) || /variasi.*(stop|off|mati|berhenti)/.test(t)) {
      clientRef.current?.publish(TOPICS.CMD_VAR, JSON.stringify({ variasi: 0 }));
      setVariasi(0); stopVarTimer();
      publishAll(false, 'voice');
      showVoiceResult('ok', '✓ Variasi dihentikan');
      addLog('Voice → Stop variasi', 'off', 'voice'); return;
    }
    // Variasi 1 / 2 / 3
    const varM = t.match(/variasi\s*(satu|1|dua|2|tiga|3|one|two|three)/);
    if (varM) {
      const n = /satu|1|one/.test(varM[1]) ? 1 : /dua|2|two/.test(varM[1]) ? 2 : 3;
      clientRef.current?.publish(TOPICS.CMD_VAR, JSON.stringify({ variasi: n }));
      setVariasi(n); startVariation(n);
      showVoiceResult('ok', `✓ Variasi ${n} diaktifkan`);
      addLog(`Voice → Variasi ${n}`, 'on', 'voice'); return;
    }
    // Lampu ON individual
    const onM = t.match(/(nyala(kan)?|hidupkan|on|aktif(kan)?)\s*(lampu\s*)?(satu|1|dua|2|tiga|3|empat|4|one|two|three|four)/);
    if (onM) {
      const id = numWord(onM[5]);
      stopVarIfNeeded();
      publishRelay(id, true, 'voice');
      showVoiceResult('ok', `✓ Lampu ${id} dinyalakan`); return;
    }
    // Lampu OFF individual
    const offM = t.match(/(matikan|mati(kan)?|off)\s*(lampu\s*)?(satu|1|dua|2|tiga|3|empat|4|one|two|three|four)/);
    if (offM) {
      const id = numWord(offM[4]);
      stopVarIfNeeded();
      publishRelay(id, false, 'voice');
      showVoiceResult('ok', `✓ Lampu ${id} dimatikan`); return;
    }

    showVoiceResult('unk', `Tidak dikenali: "${text}"`);
    addLog(`Tidak dikenali: "${text}"`, 'warn', 'voice');
  }, [addLog, showVoiceResult, stopVarTimer, startVariation, publishRelay, publishAll]);

  // ── Mic toggle ───────────────────────────────────────────────────────────────
  const toggleMic = useCallback(() => {
    if (isListening) { recognitionRef.current?.stop(); return; }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { showVoiceResult('err', 'Gunakan Chrome – Speech Recognition tidak didukung'); return; }

    const rec = new SR();
    rec.lang = 'id-ID'; rec.interimResults = true; rec.maxAlternatives = 1;
    recognitionRef.current = rec;
    let finalText = '';

    rec.onstart  = () => { setIsListening(true);  setTranscript('🎙 Mendengarkan...'); setVoiceResult(null); };
    rec.onresult = (e: any) => { finalText = Array.from(e.results as any[]).map((r:any) => r[0].transcript).join(''); setTranscript(finalText); };
    rec.onend    = () => { setIsListening(false); setTranscript(''); if (finalText) processVoiceCommand(finalText); };
    rec.onerror  = (e: any) => { setIsListening(false); setTranscript(''); showVoiceResult('err', `Error: ${e.error}`); addLog(`Voice error: ${e.error}`, 'err', 'voice'); };
    rec.start();
  }, [isListening, showVoiceResult, processVoiceCommand, addLog]);

  // ── Derived ──────────────────────────────────────────────────────────────────
  const isHighTemp       = parseFloat(sensor.suhu) >= 35.0;
  const isVariationActive = variasi > 0;

  // ── Variation meta ────────────────────────────────────────────────────────────
  const varMeta = [
    { id:1, label:'Variasi 1', desc:'Bolak-balik 1→2→3→4→3→2→1', icon: <Zap size={14}/> },
    { id:2, label:'Variasi 2', desc:'Nyala bertahap 1→2→3→4',     icon: <Play size={14}/> },
    { id:3, label:'Variasi 3', desc:'Kedip acak bebas',            icon: <Shuffle size={14}/> },
  ];

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight:'100vh', background:'#080810', color:'#e8e6ff', fontFamily:"'Syne', sans-serif", overflowX:'hidden', position:'relative' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=DM+Mono:wght@300;400;500&display=swap');
        :root {
          --accent:#6D5EF5; --accent-dim:rgba(109,94,245,0.15); --accent-glow:rgba(109,94,245,0.35);
          --bg:#080810; --bg2:#0e0e1a; --bg3:#13131f;
          --border:rgba(255,255,255,0.07); --border-accent:rgba(109,94,245,0.3);
          --text:#e8e6ff; --muted:#4a4870; --muted2:#2a2845;
          --success:#3dd68c; --danger:#ff5f7e; --warn:#f5a623;
        }
        *{box-sizing:border-box;}
        .mono{font-family:'DM Mono',monospace;}
        .bg-grid::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(109,94,245,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(109,94,245,0.03) 1px,transparent 1px);background-size:40px 40px;pointer-events:none;z-index:0;}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:.35}}
        @keyframes micPulse{0%,100%{box-shadow:0 0 0 0 rgba(255,95,126,.3)}50%{box-shadow:0 0 0 14px rgba(255,95,126,0)}}
        @keyframes relayGlow{0%,100%{box-shadow:0 0 6px rgba(109,94,245,0.6)}50%{box-shadow:0 0 16px rgba(109,94,245,1),0 0 30px rgba(109,94,245,0.4)}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes logIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}
        @keyframes varPing{0%,100%{box-shadow:0 0 0 0 rgba(109,94,245,.4)}60%{box-shadow:0 0 0 10px rgba(109,94,245,0)}}
        .dot-blink{animation:blink 2s ease infinite;}
        .mic-pulse{animation:micPulse 1.4s ease infinite;}
        .led-glow{animation:relayGlow 2s ease-in-out infinite;}
        .var-ping{animation:varPing 1.2s ease infinite;}
        .spinner{width:14px;height:14px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin .7s linear infinite;}
        .card-hover{transition:border-color .2s,box-shadow .2s;}
        .card-hover:hover{border-color:var(--border-accent)!important;}
        .log-scroll{max-height:260px;overflow-y:auto;}
        .log-scroll::-webkit-scrollbar{width:4px;}
        .log-scroll::-webkit-scrollbar-thumb{background:var(--muted2);border-radius:4px;}
        .log-row{animation:logIn .25s ease;}
        button{cursor:pointer;}
        button:disabled{opacity:.3;cursor:not-allowed!important;}
        .relay-btn{display:flex;align-items:center;justify-content:center;gap:8px;padding:11px 16px;border-radius:10px;font-family:'Syne',sans-serif;font-size:13px;font-weight:700;border:none;transition:all .15s;width:100%;}
        .relay-btn.is-on{background:var(--accent-dim);color:var(--accent);border:1px solid var(--border-accent);}
        .relay-btn.is-off{background:var(--accent);color:#fff;box-shadow:0 4px 20px rgba(109,94,245,0.35);}
        .relay-btn:hover:not(:disabled).is-on{background:rgba(109,94,245,.25);}
        .relay-btn:hover:not(:disabled).is-off{background:#7d6ff7;box-shadow:0 4px 28px rgba(109,94,245,.5);}
      `}</style>

      <div className="bg-grid" style={{ position:'fixed', inset:0, pointerEvents:'none', zIndex:0 }} />

      <div style={{ maxWidth:900, margin:'0 auto', padding:'28px 16px 60px', position:'relative', zIndex:1 }}>

        {/* ── HEADER ── */}
        <header style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:28, flexWrap:'wrap', gap:12 }}>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <div style={{ width:38, height:38, background:'var(--accent-dim)', border:'1px solid var(--border-accent)', borderRadius:10, display:'flex', alignItems:'center', justifyContent:'center' }}>
              <Home size={18} color="var(--accent)" />
            </div>
            <div>
              <h1 style={{ fontSize:18, fontWeight:700, letterSpacing:'-0.02em', margin:0 }}>Smart Home</h1>
              <p className="mono" style={{ fontSize:11, color:'var(--muted)', margin:0 }}>iot/rumah2 · HiveMQ</p>
            </div>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:6, padding:'6px 12px', borderRadius:20, fontSize:11, fontWeight:500, border:'1px solid', ...(connected ? { background:'rgba(61,214,140,0.08)', borderColor:'rgba(61,214,140,0.2)', color:'var(--success)' } : { background:'rgba(255,95,126,0.08)', borderColor:'rgba(255,95,126,0.2)', color:'var(--danger)' }) }} className="mono">
            <div className={connected ? 'dot-blink' : ''} style={{ width:7, height:7, borderRadius:'50%', background: connected ? 'var(--success)' : 'var(--danger)' }} />
            {connected ? 'Online' : 'Offline'}
          </div>
        </header>

        {/* ── SENSOR + VOICE ── */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(280px,1fr))', gap:14, marginBottom:14 }}>

          {/* Sensor */}
          <div className="card-hover" style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:16, padding:20 }}>
            <div className="mono" style={{ fontSize:11, fontWeight:600, letterSpacing:'.1em', textTransform:'uppercase', color:'var(--muted)', marginBottom:16, display:'flex', alignItems:'center', gap:8 }}>
              Sensor DHT11
            </div>
            <div style={{ display:'flex', gap:24 }}>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:42, fontWeight:800, lineHeight:1, letterSpacing:'-0.04em', color: isHighTemp ? 'var(--danger)' : 'var(--text)' }}>
                  {sensor.suhu}<span style={{ fontSize:16, color:'var(--muted)', marginLeft:3 }}>°C</span>
                </div>
                <div className="mono" style={{ fontSize:11, color:'var(--muted)', marginTop:6 }}>Suhu</div>
                {isHighTemp && (
                  <div style={{ display:'inline-flex', alignItems:'center', gap:4, background:'rgba(255,95,126,0.1)', border:'1px solid rgba(255,95,126,0.25)', color:'var(--danger)', fontSize:10, padding:'2px 8px', borderRadius:4, marginTop:4 }} className="mono">
                    <AlertTriangle size={10} /> PANAS
                  </div>
                )}
              </div>
              <div style={{ width:1, background:'var(--border)' }} />
              <div style={{ flex:1 }}>
                <div style={{ fontSize:42, fontWeight:800, lineHeight:1, letterSpacing:'-0.04em', color:'var(--text)' }}>
                  {sensor.kelembaban}<span style={{ fontSize:16, color:'var(--muted)', marginLeft:3 }}>%</span>
                </div>
                <div className="mono" style={{ fontSize:11, color:'var(--muted)', marginTop:6 }}>Kelembaban</div>
              </div>
            </div>
            <div className="mono" style={{ marginTop:14, fontSize:10, color:'var(--muted)' }}>Update: {sensor.lastUpdate}</div>
          </div>

          {/* Voice */}
          <div style={{ background:'var(--bg2)', borderRadius:16, padding:20, border: isListening ? '1px solid rgba(255,95,126,0.5)' : '1px solid var(--border)', transition:'border-color .3s' }}>
            <div className="mono" style={{ fontSize:11, fontWeight:600, letterSpacing:'.1em', textTransform:'uppercase', color:'var(--muted)', marginBottom:16, display:'flex', alignItems:'center', gap:8 }}>
              <Mic size={13} color="var(--accent)" /> Perintah Suara
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:16 }}>
              <button
                onClick={toggleMic}
                className={isListening ? 'mic-pulse' : ''}
                style={{ width:64, height:64, borderRadius:'50%', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center', background: isListening ? 'rgba(255,95,126,0.1)' : 'var(--bg3)', border: isListening ? '1px solid rgba(255,95,126,.5)' : '1px solid var(--border)', transition:'all .2s' }}
              >
                {isListening ? <MicOff size={26} color="#ff5f7e" /> : <Mic size={26} color="var(--accent)" />}
              </button>
              <div style={{ flex:1 }}>
                <div className="mono" style={{ fontSize:13, color: transcript ? 'var(--text)' : 'var(--muted)', minHeight:20, marginBottom:8 }}>
                  {transcript || 'Tekan mic untuk mulai...'}
                </div>
                {voiceResult && (
                  <div className="mono" style={{ fontSize:12, padding:'7px 12px', borderRadius:8, ...(voiceResult.type === 'ok' ? { background:'rgba(61,214,140,0.08)', border:'1px solid rgba(61,214,140,0.2)', color:'var(--success)' } : voiceResult.type === 'err' ? { background:'rgba(255,95,126,0.08)', border:'1px solid rgba(255,95,126,0.2)', color:'var(--danger)' } : { background:'rgba(245,166,35,0.08)', border:'1px solid rgba(245,166,35,0.2)', color:'var(--warn)' }) }}>
                    {voiceResult.msg}
                  </div>
                )}
              </div>
            </div>
            <div style={{ marginTop:12, display:'flex', flexWrap:'wrap', gap:6 }}>
              {['"nyalakan lampu 1"','"matikan semua"','"variasi satu"','"variasi dua"','"variasi tiga"','"stop variasi"'].map(h => (
                <span key={h} className="mono" style={{ fontSize:10, padding:'3px 8px', borderRadius:4, background:'var(--muted2)', color:'var(--muted)', border:'1px solid rgba(255,255,255,0.05)' }}>{h}</span>
              ))}
            </div>
          </div>
        </div>

        {/* ── RELAY SECTION ── */}
        <div style={{ marginBottom:14 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12, flexWrap:'wrap', gap:8 }}>
            <div className="mono" style={{ fontSize:11, fontWeight:600, letterSpacing:'.1em', textTransform:'uppercase', color:'var(--muted)', display:'flex', alignItems:'center', gap:8 }}>
              <Power size={13} color="var(--accent)" /> Kontrol Lampu
              {isVariationActive && (
                <span className="mono var-ping" style={{ fontSize:9, padding:'2px 8px', borderRadius:4, background:'rgba(109,94,245,0.15)', border:'1px solid rgba(109,94,245,0.3)', color:'var(--accent)', letterSpacing:'.05em' }}>
                  VARIASI {variasi} AKTIF
                </span>
              )}
            </div>
            <div style={{ display:'flex', gap:8 }}>
              {[{label:'Semua ON', state:true}, {label:'Semua OFF', state:false}].map(({ label, state }) => (
                <button
                  key={label}
                  onClick={() => handleSetAllRelays(state)}
                  disabled={!connected}
                  style={{ fontFamily:"'Syne',sans-serif", fontSize:12, fontWeight:600, padding:'6px 14px', borderRadius:8, border:'1px solid var(--border)', background:'var(--bg3)', color:'var(--muted)', transition:'all .15s' }}
                  onMouseEnter={e => { if(connected){(e.currentTarget as HTMLElement).style.borderColor='rgba(109,94,245,.4)';(e.currentTarget as HTMLElement).style.color='var(--text)';}}}
                  onMouseLeave={e => {(e.currentTarget as HTMLElement).style.borderColor='var(--border)';(e.currentTarget as HTMLElement).style.color='var(--muted)';}}
                >{label}</button>
              ))}
            </div>
          </div>

          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))', gap:12 }}>
            {RELAY_IDS.map(id => {
              const isON = relays[id];
              return (
                <div key={id} className="card-hover" style={{ background:'var(--bg3)', borderRadius:14, padding:18, display:'flex', flexDirection:'column', gap:14, border: isON ? '1px solid var(--border-accent)' : '1px solid var(--border)', boxShadow: isON ? '0 0 28px rgba(109,94,245,0.08)' : 'none', transition:'border-color .2s,box-shadow .2s', position:'relative', overflow:'hidden' }}>
                  {isON && <div style={{ position:'absolute', inset:0, pointerEvents:'none', background:'linear-gradient(135deg,rgba(109,94,245,0.04) 0%,transparent 60%)' }} />}
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                    <span style={{ fontSize:15, fontWeight:700, color:'var(--text)' }}>Lampu {id}</span>
                    <div className={isON ? 'led-glow' : ''} style={{ width:11, height:11, borderRadius:'50%', background: isON ? 'var(--accent)' : 'var(--muted2)', transition:'all .3s' }} />
                  </div>
                  <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                    <span className="mono" style={{ fontSize:10, padding:'3px 8px', borderRadius:4, letterSpacing:'.05em', alignSelf:'flex-start', ...(isON ? { background:'var(--accent-dim)', color:'var(--accent)', border:'1px solid var(--border-accent)' } : { background:'var(--muted2)', color:'var(--muted)', border:'1px solid rgba(255,255,255,0.05)' }) }}>
                      {isON ? 'MENYALA' : 'MATI'}
                    </span>
                    <button
                      onClick={() => toggleRelay(id)}
                      disabled={!connected}
                      className={`relay-btn ${isON ? 'is-on' : 'is-off'}`}
                    >
                      <Power size={14} />
                      {isON ? 'Matikan' : 'Nyalakan'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── VARIATION ── */}
        <div className="card-hover" style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:16, padding:20, marginBottom:14 }}>
          <div className="mono" style={{ fontSize:11, fontWeight:600, letterSpacing:'.1em', textTransform:'uppercase', color:'var(--muted)', marginBottom:8, display:'flex', alignItems:'center', gap:8 }}>
            <Play size={13} color="var(--accent)" /> Variasi Lampu
          </div>
          <p className="mono" style={{ fontSize:10, color:'var(--muted)', marginBottom:16, lineHeight:1.6 }}>
            Mode otomatis berjalan lokal. Klik tombol relay atau ucapkan perintah manual untuk stop variasi & kontrol manual.
          </p>
          <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
            {varMeta.map(({ id, label, desc, icon }) => (
              <button
                key={id}
                onClick={() => setVariation(id)}
                disabled={!connected}
                title={desc}
                style={{ flex:1, minWidth:110, padding:'12px 14px', borderRadius:12, fontFamily:"'Syne',sans-serif", fontSize:13, fontWeight:600, display:'flex', alignItems:'center', justifyContent:'center', gap:8, flexDirection:'column', transition:'all .15s', ...(variasi === id ? { background:'var(--accent-dim)', border:'1px solid var(--border-accent)', color:'var(--accent)', boxShadow:'0 0 20px rgba(109,94,245,.12)' } : { background:'var(--bg3)', border:'1px solid var(--border)', color:'var(--muted)' }) }}
              >
                <span style={{ display:'flex', alignItems:'center', gap:6 }}>{icon} {label}</span>
                <span className="mono" style={{ fontSize:9, opacity:.7, textAlign:'center', letterSpacing:0, textTransform:'none', fontWeight:400 }}>{desc}</span>
              </button>
            ))}
            <button
              onClick={() => setVariation(0)}
              disabled={!connected || variasi === 0}
              style={{ flex:1, minWidth:110, padding:'12px 14px', borderRadius:12, fontFamily:"'Syne',sans-serif", fontSize:13, fontWeight:600, display:'flex', alignItems:'center', justifyContent:'center', gap:8, transition:'all .15s', ...(variasi !== 0 ? { background:'rgba(255,95,126,.08)', border:'1px solid rgba(255,95,126,.3)', color:'var(--danger)' } : { background:'var(--bg3)', border:'1px solid var(--border)', color:'var(--muted2)' }) }}
            >
              <Square size={12} fill="currentColor" /> Stop
            </button>
          </div>
        </div>

        {/* ── LOG ── */}
        <div style={{ background:'var(--bg2)', border:'1px solid var(--border)', borderRadius:14, overflow:'hidden' }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'14px 18px', borderBottom:'1px solid var(--border)' }}>
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <span className="mono" style={{ fontSize:11, fontWeight:600, letterSpacing:'.1em', textTransform:'uppercase', color:'var(--muted)' }}>Aktivitas</span>
              <span className="mono" style={{ fontSize:10, padding:'2px 8px', borderRadius:10, background:'var(--accent-dim)', color:'var(--accent)', border:'1px solid var(--border-accent)' }}>{logs.length}</span>
            </div>
            <button onClick={() => setLogs([])} style={{ fontFamily:"'DM Mono',monospace", fontSize:11, color:'var(--muted)', background:'none', border:'none', transition:'color .15s', display:'flex', alignItems:'center', gap:4 }} onMouseEnter={e => (e.currentTarget as HTMLElement).style.color='var(--danger)'} onMouseLeave={e => (e.currentTarget as HTMLElement).style.color='var(--muted)'}>
              <Trash2 size={12} /> Hapus
            </button>
          </div>
          <div className="log-scroll">
            {logs.length === 0
              ? <div className="mono" style={{ padding:32, textAlign:'center', fontSize:12, color:'var(--muted2)' }}>Belum ada aktivitas...</div>
              : logs.map((l, i) => (
                <div key={i} className="log-row" style={{ display:'flex', alignItems:'flex-start', gap:12, padding:'9px 18px', borderBottom:'1px solid rgba(255,255,255,0.03)' }}>
                  <span className="mono" style={{ fontSize:10, color:'var(--muted)', whiteSpace:'nowrap', paddingTop:1, minWidth:60 }}>{l.time}</span>
                  <div style={{ width:7, height:7, borderRadius:'50%', flexShrink:0, marginTop:5, background: l.type==='on'?'var(--accent)':l.type==='off'?'var(--muted)':l.type==='voice'?'#ff5f7e':l.type==='err'?'var(--danger)':l.type==='warn'?'var(--warn)':'var(--success)' }} />
                  <span style={{ fontSize:13, color:'var(--text)', lineHeight:1.4, flex:1 }}>
                    {l.msg}
                    <span className="mono" style={{ fontSize:9, fontWeight:500, padding:'2px 6px', borderRadius:3, letterSpacing:'.05em', marginLeft:6, verticalAlign:'middle', ...(l.source==='web'?{background:'var(--accent-dim)',color:'var(--accent)'}:l.source==='voice'?{background:'rgba(255,95,126,0.1)',color:'var(--danger)'}:{background:'var(--muted2)',color:'var(--muted)'}) }}>
                      {l.source.toUpperCase()}
                    </span>
                  </span>
                </div>
              ))
            }
          </div>
        </div>

      </div>
    </div>
  );
}
