import { useEffect, useState, useRef, useCallback } from 'react';
import mqtt from 'mqtt';

const TOPICS = {
  STATUS_RELAY: 'iot/rumah2/relay/status',
  CMD_RELAY: 'iot/rumah2/relay/command',
  DATA_SENSOR: 'iot/rumah2/sensor/data',
  STATUS_VAR: 'iot/rumah2/variasi/status',
  CMD_VAR: 'iot/rumah2/variasi/command',
  CMD_ALL: 'iot/rumah2/relay/allcommand'
};

function parseVoiceCommand(transcript) {
  const t = transcript.toLowerCase().trim();
  if (/(nyala|hidupkan|on)\s+(semua|all)/.test(t) || /(semua|all).*(nyala|on|hidupkan)/.test(t))
    return { action: 'all_on', target: 'all' };
  if (/(mati(kan)?|off|matikan)\s+(semua|all)/.test(t) || /(semua|all).*(mati|off)/.test(t))
    return { action: 'all_off', target: 'all' };
  if (/(stop|henti(kan)?)\s+(variasi|semua)/.test(t) || /variasi\s+(stop|off|mati)/.test(t))
    return { action: 'var_stop', target: '0' };
  const varMatch = t.match(/variasi\s*(satu|1|dua|2|one|two)/);
  if (varMatch) {
    const n = /satu|1|one/.test(varMatch[1]) ? '1' : '2';
    return { action: 'variation', target: n };
  }
  const onMatch = t.match(/(nyala(kan)?|hidupkan|on|aktif(kan)?)\s+(?:lampu\s*)?(satu|1|dua|2|tiga|3|empat|4|one|two|three|four)/);
  if (onMatch) return { action: 'relay_on', target: numWord(onMatch[4]) };
  const offMatch = t.match(/(matikan|mati(kan)?|off)\s+(?:lampu\s*)?(satu|1|dua|2|tiga|3|empat|4|one|two|three|four)/);
  if (offMatch) return { action: 'relay_off', target: numWord(offMatch[3]) };
  return null;
}

function numWord(w) {
  const map = { satu: '1', dua: '2', tiga: '3', empat: '4', one: '1', two: '2', three: '3', four: '4' };
  return map[w] ?? w;
}

export default function App() {
  const [client, setClient] = useState(null);
  const [connected, setConnected] = useState(false);
  const [relays, setRelays] = useState({ 1: false, 2: false, 3: false, 4: false });
  const [sensor, setSensor] = useState({ suhu: '--', kelembaban: '--', lastUpdate: '--:--:--' });
  const [variasi, setVariasiState] = useState(0);
  const [loadingRelays, setLoadingRelays] = useState({});
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [voiceResult, setVoiceResult] = useState(null);
  const [logs, setLogs] = useState([]);

  const recognitionRef = useRef(null);
  const clientRef = useRef(null);
  const relaysRef = useRef(relays);
  const variasiRef = useRef(variasi);

  useEffect(() => { relaysRef.current = relays; }, [relays]);
  useEffect(() => { variasiRef.current = variasi; }, [variasi]);
  useEffect(() => { clientRef.current = client; }, [client]);

  const addLog = useCallback((msg, type = 'info', source = 'sys') => {
    const now = new Date();
    const time = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`;
    setLogs(prev => [{ time, msg, type, source }, ...prev].slice(0, 100));
  }, []);

  useEffect(() => {
    const clientId = `web_${Math.random().toString(16).slice(2, 10)}`;
    const mqttClient = mqtt.connect('wss://broker.hivemq.com:8884/mqtt', {
      clientId, keepalive: 60, protocolVersion: 4, clean: true,
      reconnectPeriod: 2000, connectTimeout: 30000,
    });
    setClient(mqttClient);
    addLog('Menghubungkan ke broker MQTT...', 'info', 'sys');

    mqttClient.on('connect', () => {
      setConnected(true);
      mqttClient.subscribe([TOPICS.STATUS_RELAY, TOPICS.DATA_SENSOR, TOPICS.STATUS_VAR]);
      setLoadingRelays({});
      addLog('Terhubung ke HiveMQ broker', 'info', 'sys');
    });
    mqttClient.on('reconnect', () => { setConnected(false); addLog('Mencoba reconnect...', 'warn', 'sys'); });
    mqttClient.on('offline', () => { setConnected(false); addLog('Koneksi terputus', 'err', 'sys'); });
    mqttClient.on('error', (e) => { addLog(`Error: ${e.message}`, 'err', 'sys'); });

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

  const execCommand = useCallback((cmd) => {
    const c = clientRef.current;
    if (!c) return false;
    if (cmd.action === 'all_on') { c.publish(TOPICS.CMD_ALL, JSON.stringify({ state: true })); return true; }
    if (cmd.action === 'all_off') { c.publish(TOPICS.CMD_ALL, JSON.stringify({ state: false })); return true; }
    if (cmd.action === 'variation') { c.publish(TOPICS.CMD_VAR, JSON.stringify({ variasi: parseInt(cmd.target) })); return true; }
    if (cmd.action === 'var_stop') { c.publish(TOPICS.CMD_VAR, JSON.stringify({ variasi: 0 })); return true; }
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
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setVoiceResult({ type: 'err', msg: 'Browser tidak mendukung Speech Recognition (gunakan Chrome)' });
      addLog('Speech Recognition tidak didukung browser ini', 'err', 'voice');
      return;
    }
    const rec = new SpeechRecognition();
    rec.lang = 'id-ID';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    recognitionRef.current = rec;
    let lastText = '';

    rec.onstart = () => { setListening(true); setTranscript(''); setVoiceResult(null); addLog('Mendengarkan perintah suara...', 'voice', 'voice'); };
    rec.onresult = (e) => {
      const t = Array.from(e.results).map(r => r[0].transcript).join('');
      setTranscript(t);
      lastText = t;
    };
    rec.onend = () => {
      setListening(false);
      if (lastText) {
        addLog(`Voice: "${lastText}"`, 'voice', 'voice');
        const cmd = parseVoiceCommand(lastText);
        if (cmd) {
          const ok = execCommand(cmd);
          if (ok) {
            setVoiceResult({ type: 'ok', msg: `✓ Perintah dieksekusi: "${lastText}"` });
            addLog(`Voice → Perintah berhasil`, 'on', 'voice');
          } else {
            setVoiceResult({ type: 'err', msg: 'Variasi aktif — kontrol manual dinonaktifkan' });
            addLog('Voice ditolak: variasi aktif', 'err', 'voice');
          }
        } else {
          setVoiceResult({ type: 'unk', msg: `Tidak dikenali: "${lastText}"` });
          addLog(`Voice tidak dikenali: "${lastText}"`, 'warn', 'voice');
        }
      }
    };
    rec.onerror = (e) => {
      setListening(false);
      setVoiceResult({ type: 'err', msg: `Error: ${e.error}` });
      addLog(`Voice error: ${e.error}`, 'err', 'voice');
    };
    rec.start();
  };

  const stopListening = () => { recognitionRef.current?.stop(); setListening(false); };

  const toggleRelay = (id) => {
    if (!client || !connected || variasi > 0) return;
    setLoadingRelays(p => ({ ...p, [id]: true }));
    client.publish(TOPICS.CMD_RELAY, JSON.stringify({ relay: id, state: !relays[id] }));
    addLog(`Lampu ${id} ${!relays[id] ? 'dinyalakan' : 'dimatikan'}`, !relays[id] ? 'on' : 'off', 'web');
    setTimeout(() => setLoadingRelays(p => { const n = { ...p }; delete n[id]; return n; }), 4000);
  };

  const setAllRelays = (state) => {
    if (!client || !connected || variasi > 0) return;
    client.publish(TOPICS.CMD_ALL, JSON.stringify({ state }));
    addLog(`Semua lampu ${state ? 'dinyalakan' : 'dimatikan'}`, state ? 'on' : 'off', 'web');
  };

  const setVariation = (id) => {
    if (!client || !connected) return;
    client.publish(TOPICS.CMD_VAR, JSON.stringify({ variasi: id }));
    if (id === 0) addLog('Variasi dihentikan', 'off', 'web');
    else addLog(`Variasi ${id} diaktifkan`, 'on', 'web');
  };

  const isHighTemp = parseFloat(sensor.suhu) >= 35;
  const isVariationActive = variasi > 0;

  const logDotColor = (type) => {
    if (type === 'on') return '#6D5EF5';
    if (type === 'off') return '#4a4870';
    if (type === 'info') return '#3dd68c';
    if (type === 'warn') return '#f5a623';
    if (type === 'voice') return '#ff5f7e';
    if (type === 'err') return '#ff5f7e';
    return '#4a4870';
  };

  const srcStyle = (source) => {
    if (source === 'web') return { background: 'rgba(109,94,245,0.15)', color: '#6D5EF5' };
    if (source === 'voice') return { background: 'rgba(255,95,126,0.1)', color: '#ff5f7e' };
    if (source === 'auto') return { background: 'rgba(61,214,140,0.08)', color: '#3dd68c' };
    return { background: '#2a2845', color: '#4a4870' };
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: '#080810',
      color: '#e8e6ff',
      fontFamily: "'Syne', sans-serif",
      overflowX: 'hidden',
      position: 'relative',
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=DM+Mono:wght@300;400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }

        body::before {
          content: ''; position: fixed; inset: 0;
          background-image:
            linear-gradient(rgba(109,94,245,0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(109,94,245,0.03) 1px, transparent 1px);
          background-size: 40px 40px; pointer-events: none; z-index: 0;
        }

        .sh-card {
          background: #0e0e1a;
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 16px;
          padding: 20px;
          transition: border-color .2s;
        }
        .sh-card-title {
          font-size: 11px; font-weight: 600; letter-spacing: .1em;
          text-transform: uppercase; color: #4a4870;
          margin-bottom: 16px; display: flex; align-items: center; gap: 8px;
        }
        .sh-card-title svg { color: #6D5EF5; }

        .relay-card {
          background: #13131f;
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 14px; padding: 18px;
          display: flex; flex-direction: column; gap: 14px;
          transition: border-color .2s, box-shadow .2s;
        }
        .relay-card.on {
          border-color: rgba(109,94,245,0.3);
          box-shadow: 0 0 28px rgba(109,94,245,0.08);
        }
        .relay-led {
          width: 11px; height: 11px; border-radius: 50%;
          background: #2a2845; transition: all .3s;
        }
        .relay-led.on {
          background: #6D5EF5;
          box-shadow: 0 0 10px rgba(109,94,245,0.6);
        }
        .relay-status-tag {
          font-family: 'DM Mono', monospace; font-size: 10px; font-weight: 500;
          padding: 3px 8px; border-radius: 4px; letter-spacing: .05em;
          align-self: flex-start;
        }
        .relay-status-tag.on { background: rgba(109,94,245,0.15); color: #6D5EF5; border: 1px solid rgba(109,94,245,0.3); }
        .relay-status-tag.off { background: #2a2845; color: #4a4870; border: 1px solid rgba(255,255,255,0.05); }

        .relay-toggle-btn {
          width: 100%; padding: 11px; border-radius: 10px; border: none; cursor: pointer;
          font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 700;
          letter-spacing: .02em; transition: all .15s;
          display: flex; align-items: center; justify-content: center; gap: 8px;
        }
        .relay-toggle-btn.off-state {
          background: #6D5EF5; color: #fff;
          box-shadow: 0 4px 20px rgba(109,94,245,0.35);
        }
        .relay-toggle-btn.off-state:hover:not(:disabled) { background: #7d6ff7; box-shadow: 0 4px 28px rgba(109,94,245,.5); }
        .relay-toggle-btn.on-state {
          background: rgba(109,94,245,0.15); color: #6D5EF5;
          border: 1px solid rgba(109,94,245,0.3);
        }
        .relay-toggle-btn.on-state:hover:not(:disabled) { background: rgba(109,94,245,.25); }
        .relay-toggle-btn:disabled { opacity: .35; cursor: not-allowed; box-shadow: none; }

        .btn-all {
          font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 600;
          padding: 8px 16px; border-radius: 8px; cursor: pointer;
          border: 1px solid rgba(255,255,255,0.07); background: #13131f;
          color: #4a4870; transition: all .15s; flex: 1;
        }
        .btn-all:hover:not(:disabled) { border-color: rgba(109,94,245,.4); color: #e8e6ff; }
        .btn-all:disabled { opacity: .3; cursor: not-allowed; }

        .var-btn {
          flex: 1; min-width: 120px; padding: 13px 16px; border-radius: 12px;
          border: 1px solid rgba(255,255,255,0.07); background: #13131f;
          color: #4a4870; cursor: pointer; font-family: 'Syne', sans-serif;
          font-size: 13px; font-weight: 600; transition: all .15s;
          display: flex; align-items: center; justify-content: center; gap: 8px;
        }
        .var-btn:hover:not(:disabled) { border-color: rgba(109,94,245,.4); color: #e8e6ff; }
        .var-btn.active {
          background: rgba(109,94,245,0.15); border-color: rgba(109,94,245,0.3);
          color: #6D5EF5; box-shadow: 0 0 20px rgba(109,94,245,.12);
        }
        .var-btn.stop-active { background: rgba(255,95,126,.08); border-color: rgba(255,95,126,.3); color: #ff5f7e; }
        .var-btn.stop-inactive { opacity: .3; cursor: not-allowed; }
        .var-btn:disabled { opacity: .3; cursor: not-allowed; }

        .mic-btn {
          width: 64px; height: 64px; border-radius: 50%; border: none; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          flex-shrink: 0; transition: all .2s; position: relative;
          background: #13131f; border: 1px solid rgba(255,255,255,0.07);
        }
        .mic-btn:hover:not(:disabled) { border-color: rgba(109,94,245,.4); background: rgba(109,94,245,0.15); }
        .mic-btn.active {
          background: rgba(255,95,126,0.1); border-color: rgba(255,95,126,.5);
          animation: micPulse 1.4s ease infinite;
        }
        .mic-btn:disabled { opacity: .3; cursor: not-allowed; }
        @keyframes micPulse {
          0%,100% { box-shadow: 0 0 0 0 rgba(255,95,126,.3); }
          50% { box-shadow: 0 0 0 14px rgba(255,95,126,0); }
        }

        .voice-card { transition: border-color .3s; }
        .voice-card.listening { border-color: rgba(255,95,126,0.5) !important; }

        .hint-chip {
          font-family: 'DM Mono', monospace; font-size: 10px;
          padding: 3px 8px; border-radius: 4px;
          background: #2a2845; color: #4a4870;
          border: 1px solid rgba(255,255,255,0.05);
        }

        .log-list { max-height: 260px; overflow-y: auto; padding: 8px 0; }
        .log-list::-webkit-scrollbar { width: 4px; }
        .log-list::-webkit-scrollbar-track { background: transparent; }
        .log-list::-webkit-scrollbar-thumb { background: #2a2845; border-radius: 4px; }

        .log-item {
          display: flex; align-items: flex-start; gap: 12px;
          padding: 9px 18px;
          border-bottom: 1px solid rgba(255,255,255,0.03);
          animation: logIn .25s ease;
        }
        @keyframes logIn { from { opacity:0; transform:translateY(-6px); } to { opacity:1; transform:translateY(0); } }
        .log-item:last-child { border-bottom: none; }

        .status-badge {
          display: flex; align-items: center; gap: 6px;
          padding: 6px 12px; border-radius: 20px;
          font-size: 11px; font-family: 'DM Mono', monospace; font-weight: 500;
          border: 1px solid;
        }
        .badge-online { background: rgba(61,214,140,0.08); border-color: rgba(61,214,140,0.2); color: #3dd68c; }
        .badge-offline { background: rgba(255,95,126,0.08); border-color: rgba(255,95,126,0.2); color: #ff5f7e; }
        .dot-on { background: #3dd68c; animation: blink 2s ease infinite; }
        .dot-off { background: #ff5f7e; }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.35} }

        .spinner {
          width: 14px; height: 14px; border: 2px solid currentColor;
          border-top-color: transparent; border-radius: 50%;
          animation: spin .7s linear infinite; display: inline-block;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        .logo-icon {
          width: 38px; height: 38px; background: rgba(109,94,245,0.15);
          border: 1px solid rgba(109,94,245,0.3); border-radius: 10px;
          display: flex; align-items: center; justify-content: center;
        }

        @media(max-width:600px) {
          .grid-top { grid-template-columns: 1fr !important; }
          .relay-grid { grid-template-columns: 1fr !important; }
        }
        @media(max-width:480px) {
          .relay-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>

      <div style={{ maxWidth: 900, margin: '0 auto', padding: '28px 16px 60px', position: 'relative', zIndex: 1 }}>

        {/* HEADER */}
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28, flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div className="logo-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6D5EF5" strokeWidth="1.8">
                <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>
                <polyline points="9 22 9 12 15 12 15 22"/>
              </svg>
            </div>
            <div>
              <h1 style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em' }}>Smart Home</h1>
              <p style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", color: '#4a4870', marginTop: 2 }}>rumah2 · HiveMQ</p>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className={`status-badge ${connected ? 'badge-online' : 'badge-offline'}`}>
              <div style={{ width: 7, height: 7, borderRadius: '50%' }} className={connected ? 'dot-on' : 'dot-off'}></div>
              <span>{connected ? 'Online' : 'Offline'}</span>
            </div>
          </div>
        </header>

        {/* TOP GRID: Sensor + Voice */}
        <div className="grid-top" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>

          {/* SENSOR */}
          <div className="sh-card" style={{ borderColor: isHighTemp ? 'rgba(255,95,126,0.3)' : 'rgba(255,255,255,0.07)' }}>
            <div className="sh-card-title">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M14 14.76V3.5a2.5 2.5 0 00-5 0v11.26a4.5 4.5 0 105 0z"/>
              </svg>
              Sensor
            </div>
            <div style={{ display: 'flex', gap: 24 }}>
              <div>
                <div style={{ fontSize: 42, fontWeight: 800, lineHeight: 1, letterSpacing: '-0.04em', color: isHighTemp ? '#ff5f7e' : '#e8e6ff' }}>
                  {sensor.suhu}<span style={{ fontSize: 16, color: '#4a4870', marginLeft: 3 }}>°C</span>
                </div>
                <div style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", color: '#4a4870', marginTop: 6 }}>Suhu</div>
                {isHighTemp && (
                  <div style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    background: 'rgba(255,95,126,0.1)', border: '1px solid rgba(255,95,126,0.25)',
                    color: '#ff5f7e', fontSize: 10, fontFamily: "'DM Mono', monospace",
                    padding: '2px 8px', borderRadius: 4, marginTop: 4
                  }}>⚠ SUHU TINGGI</div>
                )}
              </div>
              <div style={{ width: 1, background: 'rgba(255,255,255,0.06)' }}></div>
              <div>
                <div style={{ fontSize: 42, fontWeight: 800, lineHeight: 1, letterSpacing: '-0.04em', color: '#e8e6ff' }}>
                  {sensor.kelembaban}<span style={{ fontSize: 16, color: '#4a4870', marginLeft: 3 }}>%</span>
                </div>
                <div style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", color: '#4a4870', marginTop: 6 }}>Kelembaban</div>
              </div>
            </div>
            <div style={{ marginTop: 12, fontSize: 11, fontFamily: "'DM Mono', monospace", color: '#2a2845' }}>{sensor.lastUpdate}</div>
          </div>

          {/* VOICE */}
          <div className={`sh-card voice-card ${listening ? 'listening' : ''}`}>
            <div className="sh-card-title">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
                <path d="M19 10v2a7 7 0 01-14 0v-2"/>
                <line x1="12" y1="19" x2="12" y2="23"/>
                <line x1="8" y1="23" x2="16" y2="23"/>
              </svg>
              Perintah Suara
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
              <button
                className={`mic-btn ${listening ? 'active' : ''}`}
                onClick={listening ? stopListening : startListening}
                disabled={!connected}
              >
                {listening
                  ? <svg width="24" height="24" viewBox="0 0 24 24" fill="#ff5f7e"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>
                  : <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#4a4870" strokeWidth="1.8">
                      <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
                      <path d="M19 10v2a7 7 0 01-14 0v-2"/>
                      <line x1="12" y1="19" x2="12" y2="23"/>
                      <line x1="8" y1="23" x2="16" y2="23"/>
                    </svg>
                }
              </button>
              <div style={{ flex: 1 }}>
                <div style={{
                  fontFamily: "'DM Mono', monospace", fontSize: 13,
                  color: listening ? '#e8e6ff' : '#4a4870',
                  minHeight: 20, marginBottom: 8
                }}>
                  {listening ? (transcript || '🎙 Mendengarkan...') : (transcript || 'Tekan untuk bicara')}
                </div>
                {voiceResult && (
                  <div style={{
                    fontFamily: "'DM Mono', monospace", fontSize: 12,
                    padding: '7px 12px', borderRadius: 8,
                    background: voiceResult.type === 'ok' ? 'rgba(61,214,140,0.08)' : voiceResult.type === 'err' ? 'rgba(255,95,126,0.08)' : 'rgba(245,166,35,0.08)',
                    border: `1px solid ${voiceResult.type === 'ok' ? 'rgba(61,214,140,0.2)' : voiceResult.type === 'err' ? 'rgba(255,95,126,0.2)' : 'rgba(245,166,35,0.2)'}`,
                    color: voiceResult.type === 'ok' ? '#3dd68c' : voiceResult.type === 'err' ? '#ff5f7e' : '#f5a623',
                  }}>
                    {voiceResult.msg}
                  </div>
                )}
              </div>
            </div>
            <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {['"nyalakan lampu satu"', '"matikan semua"', '"variasi dua"', '"stop variasi"'].map(hint => (
                <span key={hint} className="hint-chip">{hint}</span>
              ))}
            </div>
          </div>
        </div>

        {/* RELAY SECTION */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase', color: '#4a4870', display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6D5EF5" strokeWidth="2.5">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="2" x2="12" y2="6"/>
              </svg>
              Kontrol Relay
              {isVariationActive && (
                <span style={{
                  fontFamily: "'DM Mono', monospace", fontSize: 9, padding: '2px 8px',
                  borderRadius: 4, background: 'rgba(109,94,245,0.15)',
                  border: '1px solid rgba(109,94,245,0.3)', color: '#6D5EF5', letterSpacing: '.05em'
                }}>VARIASI {variasi} AKTIF</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-all" onClick={() => setAllRelays(true)} disabled={!connected || isVariationActive}>Semua ON</button>
              <button className="btn-all" onClick={() => setAllRelays(false)} disabled={!connected || isVariationActive}>Semua OFF</button>
            </div>
          </div>

          <div className="relay-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {[1, 2, 3, 4].map(id => {
              const isON = relays[id];
              const isLoading = loadingRelays[id];
              return (
                <div key={id} className={`relay-card ${isON ? 'on' : ''} ${isVariationActive ? '' : ''}`}
                  style={isVariationActive ? { opacity: .5, pointerEvents: 'none' } : {}}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color: '#e8e6ff' }}>Lampu {id}</span>
                    <div className={`relay-led ${isON ? 'on' : ''}`}></div>
                  </div>
                  <span className={`relay-status-tag ${isON ? 'on' : 'off'}`}>{isON ? 'MENYALA' : 'MATI'}</span>
                  <button
                    className={`relay-toggle-btn ${isON ? 'on-state' : 'off-state'}`}
                    onClick={() => toggleRelay(id)}
                    disabled={!connected || isVariationActive || isLoading}
                  >
                    {isLoading
                      ? <span className="spinner"></span>
                      : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <circle cx="12" cy="12" r="10"/>
                          <line x1="12" y1="8" x2="12" y2="12"/>
                          <line x1="12" y1="2" x2="12" y2="6"/>
                        </svg>
                    }
                    {isLoading ? 'Tunggu...' : isON ? 'Matikan' : 'Nyalakan'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* VARIATION */}
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase', color: '#4a4870', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6D5EF5" strokeWidth="2.5">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            Variasi Lampu
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {[1, 2].map(v => (
              <button key={v} className={`var-btn ${variasi === v ? 'active' : ''}`} onClick={() => setVariation(v)} disabled={!connected}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                Variasi {v}
                <span style={{ fontSize: 10, opacity: .6, fontFamily: "'DM Mono', monospace" }}>
                  {v === 1 ? '(1→3→2→4)' : '(1→4→↩)'}
                </span>
              </button>
            ))}
            <button
              className={`var-btn ${variasi !== 0 ? 'stop-active' : 'stop-inactive'}`}
              onClick={() => setVariation(0)}
              disabled={!connected || variasi === 0}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
              Stop Variasi
            </button>
          </div>
        </div>

        {/* ACTIVITY LOG */}
        <div>
          <div style={{ background: '#0e0e1a', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 14, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
              <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.1em', textTransform: 'uppercase', color: '#4a4870', display: 'flex', alignItems: 'center', gap: 8 }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6D5EF5" strokeWidth="2.5">
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="16" y1="13" x2="8" y2="13"/>
                  <line x1="16" y1="17" x2="8" y2="17"/>
                </svg>
                Log Aktivitas
                <span style={{
                  background: 'rgba(109,94,245,0.15)', color: '#6D5EF5',
                  fontFamily: "'DM Mono', monospace", fontSize: 10,
                  padding: '2px 8px', borderRadius: 10, border: '1px solid rgba(109,94,245,0.3)'
                }}>{logs.length}</span>
              </div>
              <button
                onClick={() => setLogs([])}
                style={{
                  fontFamily: "'DM Mono', monospace", fontSize: 11, color: '#4a4870',
                  background: 'none', border: 'none', cursor: 'pointer', transition: 'color .15s'
                }}
                onMouseEnter={e => e.target.style.color='#ff5f7e'}
                onMouseLeave={e => e.target.style.color='#4a4870'}
              >Hapus semua</button>
            </div>
            <div className="log-list">
              {logs.length === 0 ? (
                <div style={{ padding: 32, textAlign: 'center', fontFamily: "'DM Mono', monospace", fontSize: 12, color: '#2a2845' }}>
                  Belum ada aktivitas...
                </div>
              ) : logs.map((log, i) => (
                <div key={i} className="log-item">
                  <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: '#4a4870', whiteSpace: 'nowrap', paddingTop: 1, minWidth: 60 }}>{log.time}</span>
                  <div style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, marginTop: 5, background: logDotColor(log.type) }}></div>
                  <span style={{ fontSize: 13, color: '#e8e6ff', lineHeight: 1.4, flex: 1 }}>
                    {log.msg}
                    <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, fontWeight: 500, padding: '2px 6px', borderRadius: 3, letterSpacing: '.05em', marginLeft: 6, verticalAlign: 'middle', ...srcStyle(log.source) }}>
                      {log.source.toUpperCase()}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <p style={{ textAlign: 'center', fontSize: 11, color: '#2a2845', fontFamily: "'DM Mono', monospace", paddingTop: 24 }}>
          broker.hivemq.com · wss:8884
        </p>
      </div>
    </div>
  );
}
