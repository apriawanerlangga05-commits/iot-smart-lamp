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
    // Generate unique client ID to avoid disconnections
    const clientId = `web_${Math.random().toString(16).slice(2, 10)}`;
    const host = 'wss://broker.hivemq.com:8884/mqtt';
    
    // Connect to the public HiveMQ web socket broker
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
      // Subscribe to all required uplink topics
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
            setLoadingRelays({}); // Clear loading spinners when status is confirmed
            break;

          case TOPICS.DATA_SENSOR:
            const now = new Date();
            const timeString = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
            
            setSensor({
              suhu: payload.suhu ?? '--',
              kelembaban: payload.kelembaban ?? '--',
              lastUpdate: timeString
            });
            break;

          case TOPICS.STATUS_VAR:
            setVariasi(payload.variasi || 0);
            break;
        }
      } catch (e) {
        console.error('Invalid JSON payload received on topic:', topic, e);
      }
    });

    // Cleanup on unmount
    return () => {
      mqttClient.end();
    };
  }, []);

  const toggleRelay = (id: number) => {
    if (!client || !connected || variasi > 0) return;
    
    setLoadingRelays(prev => ({ ...prev, [id]: true }));
    const newState = !relays[id as keyof typeof relays];
    client.publish(TOPICS.CMD_RELAY, JSON.stringify({ relay: id, state: newState }));
    
    // Safety fallback: dismiss the loading spinner if module takes too long to respond
    setTimeout(() => {
      setLoadingRelays(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
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
    <div className="min-h-screen bg-[#0D0D0D] text-gray-200 font-sans p-4 sm:p-8 flex flex-col items-center">
      <div className="w-full max-w-2xl space-y-6">
        
        {/* Header & Connection Badge */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-4 border-b border-[#2D2D2D] gap-4">
          <div className="flex items-center space-x-3 text-orange-500">
            <Cpu className="w-8 h-8" />
            <h1 className="text-2xl font-bold tracking-tight text-white">Smart Home Node</h1>
          </div>
          <div className={`self-start sm:self-auto flex items-center space-x-2 px-3 py-1.5 rounded-full text-[11px] uppercase font-bold tracking-wider ${connected ? 'bg-[#DD6B20]/15 text-[#ED8936]' : 'bg-gray-800/50 text-gray-500'}`}>
            <div className={`w-2 h-2 rounded-full ${connected ? 'bg-[#DD6B20] animate-pulse' : 'bg-gray-500'}`}></div>
            <span>{connected ? 'Connected' : 'Disconnected'}</span>
          </div>
        </div>

        {/* Sensor Card */}
        <div className="bg-[#1A1A1A] p-6 rounded-xl border border-[#2D2D2D] flex flex-col sm:flex-row sm:items-center justify-between gap-6">
          <div className="space-y-1">
            <h2 className="text-lg font-medium text-white flex items-center space-x-2">
              <span>Environment</span>
              {isHighTemp && <AlertTriangle className="w-5 h-5 text-red-500 animate-pulse" />}
            </h2>
            <p className="text-xs text-gray-500">Diperbarui: {sensor.lastUpdate}</p>
          </div>
          
          <div className="flex items-center space-x-8">
            <div className="flex items-center space-x-3">
              <div className={`p-3 rounded-lg border ${isHighTemp ? 'bg-red-500/10 text-red-500 border-red-500/20' : 'bg-[#DD6B20]/10 text-[#DD6B20] border-[#DD6B20]/20'}`}>
                <Thermometer className="w-6 h-6" />
              </div>
              <div>
                <p className="text-xs font-semibold tracking-wider text-gray-500 uppercase">Suhu</p>
                <div className="flex items-baseline space-x-1">
                  <p className={`text-2xl font-bold ${isHighTemp ? 'text-red-500' : 'text-white'}`}>{sensor.suhu}</p>
                  <span className="text-sm text-gray-400">°C</span>
                </div>
              </div>
            </div>
            
            <div className="flex items-center space-x-3">
              <div className="p-3 bg-[#DD6B20]/10 text-[#DD6B20] rounded-lg border border-[#DD6B20]/20">
                <Droplets className="w-6 h-6" />
              </div>
              <div>
                <p className="text-xs font-semibold tracking-wider text-gray-500 uppercase">Kelembaban</p>
                <div className="flex items-baseline space-x-1">
                  <p className="text-2xl font-bold text-white">{sensor.kelembaban}</p>
                  <span className="text-sm text-gray-400">%</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* All Commands */}
        <div className="flex gap-4">
          <button
            onClick={() => setAllRelays(true)}
            disabled={!connected || isVariationActive}
            className="flex-1 py-3 bg-[#1A1A1A] hover:bg-[#2A2A2A] disabled:opacity-50 disabled:cursor-not-allowed border border-[#2D2D2D] rounded-xl text-white font-medium transition-colors focus:ring-2 focus:ring-[#DD6B20]/50 outline-none"
          >
            Semua ON
          </button>
          <button
            onClick={() => setAllRelays(false)}
            disabled={!connected || isVariationActive}
            className="flex-1 py-3 bg-[#1A1A1A] hover:bg-[#2A2A2A] disabled:opacity-50 disabled:cursor-not-allowed border border-[#2D2D2D] rounded-xl text-white font-medium transition-colors focus:ring-2 focus:ring-[#DD6B20]/50 outline-none"
          >
            Semua OFF
          </button>
        </div>

        {/* Relay Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {[1, 2, 3, 4].map((id) => {
            const isON = relays[id as keyof typeof relays];
            const isLoading = loadingRelays[id];
            
            return (
              <div key={id} className="bg-[#1A1A1A] p-5 rounded-xl border border-[#2D2D2D] flex flex-col justify-between space-y-6 transition-all hover:border-[#3D3D3D]">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-gray-200">Lampu {id}</span>
                  <div className={`w-3.5 h-3.5 rounded-full transition-all duration-300 ${isON ? 'bg-[#DD6B20] shadow-[0_0_12px_rgba(221,107,32,0.8)]' : 'bg-[#3D1A00]'}`}></div>
                </div>
                
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold tracking-widest uppercase">
                    {isON ? <span className="text-[#DD6B20]">Menyala</span> : <span className="text-gray-500">Mati</span>}
                  </span>
                  
                  <button
                    onClick={() => toggleRelay(id)}
                    disabled={!connected || isVariationActive || isLoading}
                    className={`px-4 py-2.5 rounded-lg text-sm font-semibold transition-all flex items-center space-x-2 focus:ring-2 focus:ring-[#DD6B20]/50 outline-none
                      ${isON 
                        ? 'bg-[#3D1A00] text-[#FBD38D] hover:bg-[#4D2000] border border-[#DD6B20]/20' 
                        : 'bg-[#DD6B20] text-white hover:bg-[#ED8936] shadow-lg shadow-[#DD6B20]/20 border border-transparent'
                      } disabled:opacity-40 disabled:cursor-not-allowed`}
                  >
                    {isLoading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Power className="w-4 h-4" />
                    )}
                    <span>{isON ? 'Matikan' : 'Nyalakan'}</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Variations */}
        <div className="bg-[#1A1A1A] p-6 rounded-xl border border-[#2D2D2D] space-y-4">
          <div className="space-y-1">
            <h2 className="text-lg font-medium text-white">Variasi Lampu</h2>
            <p className="text-sm text-gray-500 leading-relaxed">Pilih mode variasi otomatis. Mode individual (manual) akan dinonaktifkan secara otomatis saat variasi sedang berjalan.</p>
          </div>
          
          <div className="flex flex-wrap gap-3 pt-2">
            <button
              onClick={() => setVariation(1)}
              disabled={!connected}
              className={`flex-1 min-w-[120px] py-3.5 px-4 rounded-xl font-medium flex items-center justify-center space-x-2 transition-all border outline-none focus:ring-2 focus:ring-[#DD6B20]/50
                ${variasi === 1 
                  ? 'bg-[#DD6B20]/10 text-[#DD6B20] border-[#DD6B20]/50 shadow-[0_0_20px_rgba(221,107,32,0.15)] ring-1 ring-[#DD6B20]/50' 
                  : 'bg-[#151515] text-gray-400 border-[#2D2D2D] hover:border-gray-500 hover:text-white'
                } disabled:opacity-50`}
            >
              <Play className={`w-4 h-4 ${variasi === 1 ? 'fill-current' : ''}`} />
              <span>Variasi 1</span>
            </button>

            <button
              onClick={() => setVariation(2)}
              disabled={!connected}
              className={`flex-1 min-w-[120px] py-3.5 px-4 rounded-xl font-medium flex items-center justify-center space-x-2 transition-all border outline-none focus:ring-2 focus:ring-[#DD6B20]/50
                ${variasi === 2 
                  ? 'bg-[#DD6B20]/10 text-[#DD6B20] border-[#DD6B20]/50 shadow-[0_0_20px_rgba(221,107,32,0.15)] ring-1 ring-[#DD6B20]/50' 
                  : 'bg-[#151515] text-gray-400 border-[#2D2D2D] hover:border-gray-500 hover:text-white'
                } disabled:opacity-50`}
            >
              <Play className={`w-4 h-4 ${variasi === 2 ? 'fill-current' : ''}`} />
              <span>Variasi 2</span>
            </button>

            <button
              onClick={() => setVariation(0)}
              disabled={!connected || variasi === 0}
              className={`flex-1 min-w-[120px] py-3.5 px-4 rounded-xl font-medium flex items-center justify-center space-x-2 transition-all border outline-none focus:ring-2 focus:ring-red-500/50
                ${variasi !== 0 
                  ? 'bg-red-500/10 text-red-500 border-red-500/30 hover:bg-red-500/20 shadow-[0_0_15px_rgba(239,68,68,0.1)]' 
                  : 'bg-[#151515] text-gray-600 border-[#2D2D2D]'
                } disabled:opacity-50`}
            >
              <Square className="fill-current w-3.5 h-3.5" />
              <span>Stop Variasi</span>
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}

