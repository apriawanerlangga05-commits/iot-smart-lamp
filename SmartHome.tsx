import { useEffect, useState, useRef, useCallback } from 'react';
import mqtt, { MqttClient } from 'mqtt';

const TOPICS = {
  STATUS_RELAY: 'iot/rumah2/relay/status',
  CMD_RELAY: 'iot/rumah2/relay/command',
  DATA_SENSOR: 'iot/rumah2/sensor/data',
  STATUS_VAR: 'iot/rumah2/variasi/status',
  CMD_VAR: 'iot/rumah2/variasi/command',
  CMD_ALL: 'iot/rumah2/relay/allcommand'
};

// Voice command parser
function parseVoiceCommand(transcript: string): { action: string; target: string } | null {
  const t = transcript.toLowerCase().trim();

  // All ON/OFF
  if (/(nyala|hidupkan|on)\s+(semua|all)/.test(t) || /(semua|all).*(nyala|on|hidupkan)/.test(t))
    return { action: 'all_on', target: 'all' };
  if (/(mati(kan)?|off|matikan)\s+(semua|all)/.test(t) || /(semua|all).*(mati|off)/.test(t))
    return { action: 'all_off', target: 'all' };

  // Stop variation
  if (/(stop|henti(kan)?)\s+(variasi|semua)/.test(t) || /variasi\s+(stop|off|mati)/.test(t))
    return { action: 'var_stop', target: '0' };

  // Variation 1 / 2
  const varMatch = t.match(/variasi\s*(satu|1|dua|2|one|two)/);
  if (varMatch) {
    const n = /satu|1|one/.test(varMatch[1]) ? '1' : '2';
    return { action: 'variation', target: n };
  }

  // Individual relay on
  const onMatch = t.match(/(nyala(kan)?|hidupkan|on|aktif(kan)?)\s+(?:lampu\s*)?(satu|1|dua|2|tiga|3|empat|4|one|two|three|four)/);
  if (onMatch) {
    const n = numWord(onMatch[4]);
    return { action: 'relay_on', target: n };
  }

  // Individual relay off
  const offMatch = t.match(/(matikan|mati(kan)?|off)\s+(?:lampu\s*)?(satu|1|dua|2|tiga|3|empat|4|one|two|three|four)/);
  if (offMatch) {
    const n = numWord(offMatch[3]);
    return { action: 'relay_off', target: n };
  }

  return null;
}

function numWord(w: string): string {
  const map: Record<string, string> = { satu: '1', dua: '2', tiga: '3', empat: '4', one: '1', two: '2', three: '3', four: '4' };
  return map[w] ?? w;
}

export default function App() {
  const [client, setClient] = useState<MqttClient | null>(null);
  const [connected, setConnected] = useState(false);
  const [relays, setRelays] = useState<Record<number, boolean>>({ 1: false, 2: false, 3: false, 4: false });
  const [sensor, setSensor] = useState({ suhu: '--', kelembaban: '--', lastUpdate: '--:--:--' });
  const [variasi, setVariasiState] = useState(0);
  const [loadingRelays, setLoadingRelays] = useState<Record<number, boolean>>({});

  // Voice state
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [voiceResult, setVoiceResult] = useState<{ type: 'success' | 'error' | 'unknown'; msg: string } | null>(null);
  const recognitionRef = useRef<any>(null);
  const clientRef = useRef<MqttClient | null>(null);
  const relaysRef = useRef(relays);
  const variasiRef = useRef(variasi);

  useEffect(() => { relaysRef.current = relays; }, [relays]);
  useEffect(() => { variasiRef.current = variasi; }, [variasi]);
  useEffect(() => { clientRef.current = client; }, [client]);

  useEffect(() => {
    const clientId = `web_${Math.random().toString(16).slice(2, 10)}`;
    const mqttClient = mqtt.connect('wss://broker.hivemq.com:8884/mqtt', {
      clientId, keepalive: 60, protocolVersion: 4, clean: true,
      reconnectPeriod: 2000, connectTimeout: 30000,
    });
    setClient(mqttClient);

    mqttClient.on('connect', () => {
      setConnected(true);
      mqttClient.subscribe([TOPICS.STATUS_RELAY, TOPICS.DATA_SENSOR, TOPICS.STATUS_VAR]);
      setLoadingRelays({});
    });
    mqttClient.on('reconnect', () => setConnected(false));
    mqttClient.on('offline', () => setConnected(false));
    mqttClient.on('error', (e) => console.error(e));

    mqttClient.on('message', (topic, message) => {
      try {
        const payload = JSON.parse(message.toString());
        if (topic === TOPICS.STATUS_RELAY) {
          setRelays({ 1: !!payload.relay1, 2: !!payload.relay2, 3: !!payload.relay3, 4: !!payload.relay4 });
          setLoadingRelays({});
        } else if (topic === TOPICS.DATA_SENSOR) {
          const now = new Date();
          setSensor({
            suhu: payload.suhu ?? '--',
            kelembaban: payload.kelembaban ?? '--',
            lastUpdate: `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`
          });
        } else if (topic === TOPICS.STATUS_VAR) {
          setVariasiState(payload.variasi || 0);
        }
      } catch (e) {}
    });

    return () => { mqttClient.end(); };
  }, []);

  const execCommand = useCallback((cmd: { action: string; target: string }) => {
    const c = clientRef.current;
    if (!c) return false;

    if (cmd.action === 'all_on') {
      c.publish(TOPICS.CMD_ALL, JSON.stringify({ state: true }));
      return true;
    }
    if (cmd.action === 'all_off') {
      c.publish(TOPICS.CMD_ALL, JSON.stringify({ state: false }));
      return true;
    }
    if (cmd.action === 'variation') {
      c.publish(TOPICS.CMD_VAR, JSON.stringify({ variasi: parseInt(cmd.target) }));
      return true;
    }
    if (cmd.action === 'var_stop') {
      c.publish(TOPICS.CMD_VAR, JSON.stringify({ variasi: 0 }));
      return true;
    }
    if (cmd.action === 'relay_on' || cmd.action === 'relay_off') {
      if (variasiRef.current > 0) return false;
      const id = parseInt(cmd.target);
      const state = cmd.action === 'relay_on';
      setLoadingRelays(p => ({ ...p, [id]: true }));
      c.publish(TOPICS.CMD_RELAY, JSON.stringify({ relay: id, state }));
      setTimeout(() => setLoadingRelays(p => { const n = { ...p }; delete n[id]; return n; }), 4000);
      return true;
    }
    return false;
  }, []);

  const startListening = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setVoiceResult({ type: 'error', msg: 'Browser tidak mendukung Speech Recognition' });
      return;
    }
    const rec = new SpeechRecognition();
    rec.lang = 'id-ID';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    recognitionRef.current = rec;

    rec.onstart = () => { setListening(true); setTranscript(''); setVoiceResult(null); };
    rec.onresult = (e: any) => {
      const t = Array.from(e.results).map((r: any) => r[0].transcript).join('');
      setTranscript(t);
    };
    rec.onend = () => {
      setListening(false);
      const finalTranscript = recognitionRef.current?._lastTranscript || '';
      if (finalTranscript) {
        const cmd = parseVoiceCommand(finalTranscript);
        if (cmd) {
          const ok = execCommand(cmd);
          setVoiceResult(ok
            ? { type: 'success', msg: `✓ Perintah dieksekusi: "${finalTranscript}"` }
            : { type: 'error', msg: 'Variasi aktif — kontrol manual dinonaktifkan' }
          );
        } else {
          setVoiceResult({ type: 'unknown', msg: `Tidak dikenali: "${finalTranscript}"` });
        }
      }
    };
    rec.onerror = (e: any) => {
      setListening(false);
      setVoiceResult({ type: 'error', msg: `Error: ${e.error}` });
    };

    // Patch to store last transcript
    const origOnResult = rec.onresult;
    rec.onresult = (e: any) => {
      origOnResult(e);
      const t = Array.from(e.results).map((r: any) => r[0].transcript).join('');
      rec._lastTranscript = t;
    };

    rec.start();
  };

  const stopListening = () => {
    recognitionRef.current?.stop();
    setListening(false);
  };

  const toggleRelay = (id: number) => {
    if (!client || !connected || variasi > 0) return;
    setLoadingRelays(p => ({ ...p, [id]: true }));
    client.publish(TOPICS.CMD_RELAY, JSON.stringify({ relay: id, state: !relays[id] }));
    setTimeout(() => setLoadingRelays(p => { const n = { ...p }; delete n[id]; return n; }), 4000);
  };

  const setAllRelays = (state: boolean) => {
    if (!client || !connected || variasi > 0) return;
    client.publish(TOPICS.CMD_ALL, JSON.stringify({ state }));
  };

  const setVariation = (id: number) => {
    if (!client || !connected) return;
    client.publish(TOPICS.CMD_VAR, JSON.stringify({ variasi: id }));
  };

  const isHighTemp = parseFloat(sensor.suhu as string) >= 35;
  const isVariationActive = variasi > 0;

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #0a0a0f 0%, #0f0f1a 50%, #0a0f0a 100%)',
      color: '#e2e8f0',
      fontFamily: "'Space Grotesk', 'Inter', sans-serif",
      padding: '24px 16px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .card { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07); border-radius: 16px; }
        .card-glow-orange { border-color: rgba(251,146,60,0.2); box-shadow: 0 0 40px rgba(251,146,60,0.04); }
        .card-glow-red { border-color: rgba(239,68,68,0.3); box-shadow: 0 0 40px rgba(239,68,68,0.08); }
        .relay-btn { cursor: pointer; border: none; border-radius: 10px; padding: 10px 18px; font-family: inherit; font-size: 13px; font-weight: 600; letter-spacing: 0.02em; transition: all 0.15s ease; display: flex; align-items: center; gap: 8px; }
        .relay-btn:disabled { opacity: 0.35; cursor: not-allowed; }
        .relay-btn-on { background: rgba(251,146,60,0.12); color: #fb923c; border: 1px solid rgba(251,146,60,0.25); }
        .relay-btn-on:hover:not(:disabled) { background: rgba(251,146,60,0.2); }
        .relay-btn-off { background: rgba(251,146,60,0.85); color: #fff; border: 1px solid transparent; box-shadow: 0 4px 20px rgba(251,146,60,0.3); }
        .relay-btn-off:hover:not(:disabled) { background: #fb923c; box-shadow: 0 4px 28px rgba(251,146,60,0.45); }
        .ctrl-btn { cursor: pointer; border: 1px solid rgba(255,255,255,0.1); border-radius: 10px; padding: 12px 20px; font-family: inherit; font-size: 13px; font-weight: 500; transition: all 0.15s ease; }
        .ctrl-btn:disabled { opacity: 0.3; cursor: not-allowed; }
        .ctrl-btn-neutral { background: rgba(255,255,255,0.04); color: #94a3b8; }
        .ctrl-btn-neutral:hover:not(:disabled) { background: rgba(255,255,255,0.08); color: #e2e8f0; border-color: rgba(255,255,255,0.15); }
        .var-btn { cursor: pointer; border-radius: 10px; padding: 12px 16px; font-family: inherit; font-size: 13px; font-weight: 500; transition: all 0.2s ease; display: flex; align-items: center; gap: 8px; flex: 1; justify-content: center; }
        .var-btn:disabled { opacity: 0.3; cursor: not-allowed; }
        .var-btn-inactive { background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); color: #64748b; }
        .var-btn-inactive:hover:not(:disabled) { border-color: rgba(255,255,255,0.15); color: #94a3b8; }
        .var-btn-active { background: rgba(251,146,60,0.1); border: 1px solid rgba(251,146,60,0.35); color: #fb923c; box-shadow: 0 0 20px rgba(251,146,60,0.1); }
        .var-btn-stop-active { background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.3); color: #f87171; }
        .var-btn-stop-inactive { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); color: #334155; }
        .mic-btn { width: 80px; height: 80px; border-radius: 50%; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s ease; position: relative; }
        .mic-idle { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.12); }
        .mic-idle:hover { background: rgba(255,255,255,0.09); border-color: rgba(255,255,255,0.2); }
        .mic-active { background: rgba(239,68,68,0.15); border: 2px solid rgba(239,68,68,0.5); animation: pulseRing 1.5s ease infinite; }
        .mic-disabled { opacity: 0.3; cursor: not-allowed; }
        @keyframes pulseRing {
          0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.3); }
          50% { box-shadow: 0 0 0 16px rgba(239,68,68,0); }
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .spinner { animation: spin 0.8s linear infinite; }
        .dot-pulse { width: 8px; height: 8px; border-radius: 50%; }
        .dot-online { background: #4ade80; animation: blink 2s ease-in-out infinite; }
        .dot-offline { background: #475569; }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
        .led { width: 10px; height: 10px; border-radius: 50%; }
        .led-on { background: #fb923c; box-shadow: 0 0 10px rgba(251,146,60,0.7); }
        .led-off { background: #1e293b; }
        .tag { font-family: 'JetBrains Mono', monospace; font-size: 11px; padding: 3px 8px; border-radius: 6px; }
        .tag-on { background: rgba(251,146,60,0.12); color: #fb923c; border: 1px solid rgba(251,146,60,0.2); }
        .tag-off { background: rgba(255,255,255,0.04); color: #475569; border: 1px solid rgba(255,255,255,0.06); }
        .badge-connected { background: rgba(74,222,128,0.08); color: #4ade80; border: 1px solid rgba(74,222,128,0.2); padding: 5px 12px; border-radius: 20px; font-size: 12px; font-weight: 500; display: flex; align-items: center; gap: 6px; }
        .badge-disconnected { background: rgba(71,85,105,0.2); color: #475569; border: 1px solid rgba(71,85,105,0.2); padding: 5px 12px; border-radius: 20px; font-size: 12px; font-weight: 500; display: flex; align-items: center; gap: 6px; }
        .transcript-box { font-family: 'JetBrains Mono', monospace; font-size: 13px; color: #94a3b8; min-height: 24px; text-align: center; padding: 8px; }
        .voice-hint { font-size: 11px; color: #334155; text-align: center; line-height: 1.7; }
      `}</style>

      <div style={{ width: '100%', maxWidth: '640px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fb923c" strokeWidth="1.5"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
              <h1 style={{ fontSize: '20px', fontWeight: '600', color: '#f1f5f9', letterSpacing: '-0.02em' }}>Smart Home</h1>
            </div>
            <p style={{ fontSize: '12px', color: '#334155', marginTop: '2px', fontFamily: "'JetBrains Mono', monospace" }}>rumah2 · HiveMQ</p>
          </div>
          <div className={connected ? 'badge-connected' : 'badge-disconnected'}>
            <div className={`dot-pulse ${connected ? 'dot-online' : 'dot-offline'}`}></div>
            {connected ? 'Online' : 'Offline'}
          </div>
        </div>

        {/* Sensor */}
        <div className={`card ${isHighTemp ? 'card-glow-red' : 'card-glow-orange'}`} style={{ padding: '20px 24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', gap: '32px' }}>
              <div>
                <p style={{ fontSize: '11px', fontWeight: '500', color: '#475569', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '6px' }}>Suhu</p>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                  <span style={{ fontSize: '32px', fontWeight: '300', color: isHighTemp ? '#f87171' : '#f1f5f9', letterSpacing: '-0.03em' }}>{sensor.suhu}</span>
                  <span style={{ fontSize: '14px', color: '#475569' }}>°C</span>
                </div>
              </div>
              <div style={{ width: '1px', background: 'rgba(255,255,255,0.06)' }}></div>
              <div>
                <p style={{ fontSize: '11px', fontWeight: '500', color: '#475569', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '6px' }}>Kelembaban</p>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px' }}>
                  <span style={{ fontSize: '32px', fontWeight: '300', color: '#f1f5f9', letterSpacing: '-0.03em' }}>{sensor.kelembaban}</span>
                  <span style={{ fontSize: '14px', color: '#475569' }}>%</span>
                </div>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              {isHighTemp && (
                <div style={{ marginBottom: '8px', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: '8px', padding: '6px 10px', fontSize: '11px', color: '#f87171', fontWeight: '600' }}>
                  ⚠ SUHU TINGGI
                </div>
              )}
              <p style={{ fontSize: '11px', color: '#334155', fontFamily: "'JetBrains Mono', monospace" }}>{sensor.lastUpdate}</p>
            </div>
          </div>
        </div>

        {/* Voice Command */}
        <div className="card" style={{ padding: '24px', background: 'rgba(239,68,68,0.02)', borderColor: listening ? 'rgba(239,68,68,0.35)' : 'rgba(255,255,255,0.07)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
            <span style={{ fontSize: '14px', fontWeight: '500', color: '#94a3b8' }}>Perintah Suara</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
            <button
              className={`mic-btn ${!connected ? 'mic-disabled' : listening ? 'mic-active' : 'mic-idle'}`}
              onClick={listening ? stopListening : startListening}
              disabled={!connected}
              title={listening ? 'Hentikan' : 'Mulai bicara'}
            >
              {listening ? (
                <svg width="32" height="32" viewBox="0 0 24 24" fill="#ef4444"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
              ) : (
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.5"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
              )}
            </button>

            <div className="transcript-box">
              {listening ? (transcript || '🎙 Mendengarkan...') : (transcript || '')}
            </div>

            {voiceResult && (
              <div style={{
                width: '100%', padding: '10px 14px', borderRadius: '10px', fontSize: '13px', fontFamily: "'JetBrains Mono', monospace",
                background: voiceResult.type === 'success' ? 'rgba(74,222,128,0.07)' : voiceResult.type === 'error' ? 'rgba(239,68,68,0.07)' : 'rgba(251,146,60,0.07)',
                border: `1px solid ${voiceResult.type === 'success' ? 'rgba(74,222,128,0.2)' : voiceResult.type === 'error' ? 'rgba(239,68,68,0.2)' : 'rgba(251,146,60,0.2)'}`,
                color: voiceResult.type === 'success' ? '#4ade80' : voiceResult.type === 'error' ? '#f87171' : '#fb923c',
              }}>
                {voiceResult.msg}
              </div>
            )}

            <div className="voice-hint">
              Contoh perintah: <span style={{ color: '#475569' }}>"nyalakan lampu satu"</span> · <span style={{ color: '#475569' }}>"matikan semua"</span> · <span style={{ color: '#475569' }}>"variasi dua"</span> · <span style={{ color: '#475569' }}>"stop variasi"</span>
            </div>
          </div>
        </div>

        {/* All relay controls */}
        <div style={{ display: 'flex', gap: '12px' }}>
          <button className="ctrl-btn ctrl-btn-neutral" style={{ flex: 1 }} onClick={() => setAllRelays(true)} disabled={!connected || isVariationActive}>
            Semua ON
          </button>
          <button className="ctrl-btn ctrl-btn-neutral" style={{ flex: 1 }} onClick={() => setAllRelays(false)} disabled={!connected || isVariationActive}>
            Semua OFF
          </button>
        </div>

        {/* Relay grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          {[1, 2, 3, 4].map((id) => {
            const isON = relays[id];
            const isLoading = loadingRelays[id];
            return (
              <div key={id} className="card" style={{ padding: '18px', display: 'flex', flexDirection: 'column', gap: '16px', borderColor: isON ? 'rgba(251,146,60,0.18)' : 'rgba(255,255,255,0.06)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div className={`led ${isON ? 'led-on' : 'led-off'}`}></div>
                    <span style={{ fontSize: '14px', fontWeight: '500', color: '#cbd5e1' }}>Lampu {id}</span>
                  </div>
                  <span className={`tag ${isON ? 'tag-on' : 'tag-off'}`}>{isON ? 'ON' : 'OFF'}</span>
                </div>
                <button
                  className={`relay-btn ${isON ? 'relay-btn-on' : 'relay-btn-off'}`}
                  onClick={() => toggleRelay(id)}
                  disabled={!connected || isVariationActive || isLoading}
                  style={{ width: '100%', justifyContent: 'center' }}
                >
                  {isLoading
                    ? <span className="spinner" style={{ display: 'inline-block', width: 14, height: 14, border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%' }}></span>
                    : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="2" x2="12" y2="6"/></svg>
                  }
                  {isON ? 'Matikan' : 'Nyalakan'}
                </button>
              </div>
            );
          })}
        </div>

        {/* Variations */}
        <div className="card" style={{ padding: '20px 24px' }}>
          <div style={{ marginBottom: '16px' }}>
            <p style={{ fontSize: '14px', fontWeight: '500', color: '#94a3b8' }}>Variasi Lampu</p>
            <p style={{ fontSize: '12px', color: '#334155', marginTop: '4px' }}>Mode otomatis — relay manual dinonaktifkan saat variasi aktif</p>
          </div>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            {[1, 2].map(v => (
              <button key={v} className={`var-btn ${variasi === v ? 'var-btn-active' : 'var-btn-inactive'}`} onClick={() => setVariation(v)} disabled={!connected}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill={variasi === v ? '#fb923c' : 'currentColor'}><polygon points="5 3 19 12 5 21 5 3"/></svg>
                Variasi {v}
              </button>
            ))}
            <button
              className={`var-btn ${variasi !== 0 ? 'var-btn-stop-active' : 'var-btn-stop-inactive'}`}
              onClick={() => setVariation(0)}
              disabled={!connected || variasi === 0}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
              Stop
            </button>
          </div>
        </div>

        <p style={{ textAlign: 'center', fontSize: '11px', color: '#1e293b', fontFamily: "'JetBrains Mono', monospace", paddingTop: '8px' }}>
          broker.hivemq.com · wss:8884
        </p>
      </div>
    </div>
  );
}
