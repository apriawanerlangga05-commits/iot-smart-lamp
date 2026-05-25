import { useEffect, useState } from 'react';
import mqtt, { MqttClient } from 'mqtt';
import { Thermometer, Droplets, Power, Play, Square, Loader2, AlertTriangle, Cpu } from 'lucide-react';

const TOPICS = {
  STATUS_RELAY: 'iot/rumah2/relay/status',
  CMD_RELAY: 'iot/rumah2/relay/command',
  DATA_SENSOR: 'iot/rumah2/sensor/data',
  STATUS_VAR: 'iot/rumah2/variasi/status',
  CMD_VAR: 'iot/rumah2/variasi/command',
  CMD_ALL: 'iot/rumah2/relay/allcommand'
};

export default function App() {
  const [client, setClient] = useState<MqttClient | null>(null);
  const [connected, setConnected] = useState(false);
  const [relays, setRelays] = useState({ 1: false, 2: false, 3: false, 4: false });
  const [sensor, setSensor] = useState({ suhu: '--', kelembaban: '--', lastUpdate: '--:--:--' });
  const [variasi, setVariasi] = useState(0);
  const [loadingRelays, setLoadingRelays] = useState<Record<number, boolean>>({});

  useEffect(() => {
    const clientId = `web_${Math.random().toString(16).slice(2, 10)}`;
    const host = 'wss://broker.hivemq.com:8884/mqtt';

    const mqttClient = mqtt.connect(host, {
      clientId,
      keepalive: 60,
      protocolVersion: 4,
      clean: true,
      reconnectPeriod: 2000,
      connectTimeout: 30 * 1000,
    });

    setClient(mqttClient);

    mqttClient.on('connect', () => {
      setConnected(true);
      mqttClient.subscribe([TOPICS.STATUS_RELAY, TOPICS.DATA_SENSOR, TOPICS.STATUS_VAR]);
      setLoadingRelays({});
    });

    mqttClient.on('reconnect', () => setConnected(false));
    mqttClient.on('offline', () => setConnected(false));
    mqttClient.on('error', (err) => console.error('MQTT Error:', err));

    mqttClient.on('message', (topic, message) => {
      try {
        const payload = JSON.parse(message.toString());
        switch (topic) {
          case TOPICS.STATUS_RELAY:
            setRelays({
              1: payload.relay1 || false,
              2: payload.relay2 || false,
              3: payload.relay3 || false,
              4: payload.relay4 || false,
            });
            setLoadingRelays({});
            break;
          case TOPICS.DATA_SENSOR:
            const now = new Date();
            const timeString = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
            setSensor({ suhu: payload.suhu ?? '--', kelembaban: payload.kelembaban ?? '--', lastUpdate: timeString });
            break;
          case TOPICS.STATUS_VAR:
            setVariasi(payload.variasi || 0);
            break;
        }
      } catch (e) {
        console.error('Invalid JSON payload received on topic:', topic, e);
      }
    });

    return () => { mqttClient.end(); };
  }, []);

  const toggleRelay = (id: number) => {
    if (!client || !connected || variasi > 0) return;
    setLoadingRelays(prev => ({ ...prev, [id]: true }));
    const newState = !relays[id as keyof typeof relays];
    client.publish(TOPICS.CMD_RELAY, JSON.stringify({ relay: id, state: newState }));
    setTimeout(() => {
      setLoadingRelays(prev => { const next = { ...prev }; delete next[id]; return next; });
    }, 4000);
  };

  const setAllRelays = (state: boolean) => {
    if (!client || !connected || variasi > 0) return;
    client.publish(TOPICS.CMD_ALL, JSON.stringify({ state }));
  };

  const setVariation = (id: number) => {
    if (!client || !connected) return;
    client.publish(TOPICS.CMD_VAR, JSON.stringify({ variasi: id }));
  };

  const isHighTemp = parseFloat(sensor.suhu) >= 35.0;
  const isVariationActive = variasi > 0;

  return (
    <div
      className="min-h-screen text-white p-4 sm:p-8 flex flex-col items-center"
      style={{
        background: '#05070F',
        fontFamily: "'DM Sans', sans-serif",
        backgroundImage: `radial-gradient(ellipse 80% 50% at 50% -10%, rgba(14,165,233,0.12), transparent)`,
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@300;400;500&display=swap');
        .mono { font-family: 'JetBrains Mono', monospace; }
        @keyframes pulseGlow {
          0%, 100% { box-shadow: 0 0 6px rgba(14,165,233,0.6); }
          50% { box-shadow: 0 0 16px rgba(14,165,233,1), 0 0 30px rgba(14,165,233,0.4); }
        }
        @keyframes connPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        .relay-glow { animation: pulseGlow 2s ease-in-out infinite; }
        .conn-blink { animation: connPulse 2s ease infinite; }
        .card-hover { transition: border-color 0.2s, box-shadow 0.2s; }
        .card-hover:hover { border-color: rgba(14,165,233,0.2) !important; box-shadow: 0 0 24px rgba(14,165,233,0.05); }
      `}</style>

      <div className="w-full max-w-2xl space-y-5">

        {/* HEADER */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-2">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center"
              style={{ background: 'rgba(14,165,233,0.12)', border: '1px solid rgba(14,165,233,0.2)' }}>
              <Cpu className="w-4 h-4" style={{ color: '#0ea5e9' }} />
            </div>
            <div>
              <h1 className="text-base font-semibold tracking-tight text-white">Smart Home Node</h1>
              <p className="mono text-[10px]" style={{ color: '#334155' }}>iot/rumah2 · HiveMQ</p>
            </div>
          </div>

          <div
            className="self-start sm:self-auto flex items-center gap-2 px-3 py-1.5 rounded-full mono text-[10px] font-medium uppercase tracking-widest"
            style={connected
              ? { background: 'rgba(14,165,233,0.08)', border: '1px solid rgba(14,165,233,0.2)', color: '#38bdf8' }
              : { background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.15)', color: '#f87171' }
            }
          >
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'conn-blink' : ''}`}
              style={{ background: connected ? '#38bdf8' : '#f87171' }} />
            {connected ? 'Connected' : 'Disconnected'}
          </div>
        </div>

        {/* SENSOR */}
        <div className="card-hover rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-5"
          style={{ background: '#0B1020', border: '1px solid rgba(255,255,255,0.05)' }}>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-white">Environment</span>
              {isHighTemp && <AlertTriangle className="w-4 h-4 animate-pulse" style={{ color: '#f87171' }} />}
            </div>
            <p className="mono text-[10px] mt-0.5" style={{ color: '#334155' }}>Diperbarui: {sensor.lastUpdate}</p>
          </div>

          <div className="flex items-center gap-8">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center"
                style={isHighTemp
                  ? { background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }
                  : { background: 'rgba(14,165,233,0.08)', border: '1px solid rgba(14,165,233,0.15)' }
                }>
                <Thermometer className="w-5 h-5" style={{ color: isHighTemp ? '#f87171' : '#0ea5e9' }} />
              </div>
              <div>
                <p className="mono text-[9px] uppercase tracking-widest mb-0.5" style={{ color: '#334155' }}>Suhu</p>
                <div className="flex items-baseline gap-0.5">
                  <span className="text-2xl font-bold" style={{ color: isHighTemp ? '#f87171' : '#fff', letterSpacing: '-0.04em' }}>{sensor.suhu}</span>
                  <span className="text-xs" style={{ color: '#475569' }}>°C</span>
                </div>
              </div>
            </div>

            <div style={{ width: 1, height: 36, background: 'rgba(255,255,255,0.05)' }} />

            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center"
                style={{ background: 'rgba(14,165,233,0.08)', border: '1px solid rgba(14,165,233,0.15)' }}>
                <Droplets className="w-5 h-5" style={{ color: '#0ea5e9' }} />
              </div>
              <div>
                <p className="mono text-[9px] uppercase tracking-widest mb-0.5" style={{ color: '#334155' }}>Kelembaban</p>
                <div className="flex items-baseline gap-0.5">
                  <span className="text-2xl font-bold text-white" style={{ letterSpacing: '-0.04em' }}>{sensor.kelembaban}</span>
                  <span className="text-xs" style={{ color: '#475569' }}>%</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ALL COMMANDS */}
        <div className="flex gap-3">
          {[{ label: 'Semua ON', state: true }, { label: 'Semua OFF', state: false }].map(({ label, state }) => (
            <button
              key={label}
              onClick={() => setAllRelays(state)}
              disabled={!connected || isVariationActive}
              className="flex-1 py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ background: '#0B1020', border: '1px solid rgba(255,255,255,0.07)', color: '#94a3b8' }}
              onMouseEnter={e => { if (connected && !isVariationActive) { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(14,165,233,0.3)'; (e.currentTarget as HTMLElement).style.color = '#fff'; } }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(255,255,255,0.07)'; (e.currentTarget as HTMLElement).style.color = '#94a3b8'; }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* RELAY GRID */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="mono text-[10px] uppercase tracking-widest" style={{ color: '#334155' }}>Kontrol Lampu</p>
            {isVariationActive && (
              <span className="mono text-[9px] px-2 py-0.5 rounded-full uppercase tracking-widest"
                style={{ background: 'rgba(14,165,233,0.1)', border: '1px solid rgba(14,165,233,0.2)', color: '#38bdf8' }}>
                Variasi {variasi} Aktif
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[1, 2, 3, 4].map((id) => {
              const isON = relays[id as keyof typeof relays];
              const isLoading = loadingRelays[id];

              return (
                <div
                  key={id}
                  className="card-hover rounded-2xl p-5 flex flex-col gap-4"
                  style={{
                    background: '#0B1020',
                    border: isON ? '1px solid rgba(14,165,233,0.25)' : '1px solid rgba(255,255,255,0.05)',
                    boxShadow: isON ? '0 0 28px rgba(14,165,233,0.06)' : 'none',
                    position: 'relative',
                    overflow: 'hidden',
                  }}
                >
                  {isON && (
                    <div style={{
                      position: 'absolute', inset: 0, pointerEvents: 'none',
                      background: 'linear-gradient(135deg, rgba(14,165,233,0.04) 0%, transparent 60%)',
                    }} />
                  )}

                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-sm text-white">Lampu {id}</span>
                    <div
                      className={isON ? 'relay-glow' : ''}
                      style={{
                        width: 10, height: 10, borderRadius: '50%',
                        background: isON ? '#0ea5e9' : '#1e293b',
                        transition: 'all 0.3s',
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="mono text-[10px] uppercase tracking-widest"
                      style={{ color: isON ? '#38bdf8' : '#334155' }}>
                      {isON ? 'Menyala' : 'Mati'}
                    </span>

                    <button
                      onClick={() => toggleRelay(id)}
                      disabled={!connected || isVariationActive || isLoading}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                      style={isON
                        ? { background: 'rgba(14,165,233,0.1)', border: '1px solid rgba(14,165,233,0.2)', color: '#38bdf8' }
                        : { background: '#0ea5e9', border: '1px solid transparent', color: '#05070F', boxShadow: '0 4px 14px rgba(14,165,233,0.3)' }
                      }
                    >
                      {isLoading
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <Power className="w-3.5 h-3.5" />
                      }
                      {isON ? 'Matikan' : 'Nyalakan'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* VARIATIONS */}
        <div className="card-hover rounded-2xl p-5 space-y-4"
          style={{ background: '#0B1020', border: '1px solid rgba(255,255,255,0.05)' }}>
          <div>
            <h2 className="text-sm font-semibold text-white">Variasi Lampu</h2>
            <p className="mono text-[10px] mt-1 leading-relaxed" style={{ color: '#334155' }}>
              Mode otomatis. Kontrol manual dinonaktifkan saat variasi berjalan.
            </p>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            {[1, 2].map((v) => (
              <button
                key={v}
                onClick={() => setVariation(v)}
                disabled={!connected}
                className="flex-1 min-w-[100px] py-3 px-4 rounded-xl text-xs font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-30"
                style={variasi === v
                  ? { background: 'rgba(14,165,233,0.1)', border: '1px solid rgba(14,165,233,0.3)', color: '#38bdf8', boxShadow: '0 0 18px rgba(14,165,233,0.1)' }
                  : { background: '#0d1525', border: '1px solid rgba(255,255,255,0.06)', color: '#475569' }
                }
              >
                <Play className={`w-3.5 h-3.5 ${variasi === v ? 'fill-current' : ''}`} />
                Variasi {v}
              </button>
            ))}

            <button
              onClick={() => setVariation(0)}
              disabled={!connected || variasi === 0}
              className="flex-1 min-w-[100px] py-3 px-4 rounded-xl text-xs font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-30"
              style={variasi !== 0
                ? { background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#f87171' }
                : { background: '#0d1525', border: '1px solid rgba(255,255,255,0.06)', color: '#1e293b' }
              }
            >
              <Square className="fill-current w-3 h-3" />
              Stop Variasi
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
