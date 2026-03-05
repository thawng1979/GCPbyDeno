// main.ts - VLESS WebSocket Proxy Server with Clash Meta Link Support
import { exists } from "https://deno.land/std/fs/exists.ts";

// Environment variables
const envUUID = Deno.env.get('UUID') || 'e5185305-1984-4084-81e0-f77271159c62';
const proxyIP = Deno.env.get('PROXYIP') || '';
const credit = Deno.env.get('CREDIT') || 'Deno-VLESS-Server';

const CONFIG_FILE = 'config.json';

interface Config {
  uuid?: string;
}

/**
* UUID validation
*/
function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
* Read UUID from config file
*/
async function getUUIDFromConfig(): Promise<string | undefined> {
  if (await exists(CONFIG_FILE)) {
    try {
      const configText = await Deno.readTextFile(CONFIG_FILE);
      const config: Config = JSON.parse(configText);
      if (config.uuid && isValidUUID(config.uuid)) {
        console.log(`✅ Loaded UUID from config: ${config.uuid}`);
        return config.uuid;
      }
    } catch (e) {
      console.warn(`⚠️ Config error: ${e.message}`);
    }
  }
  return undefined;
}

/**
* Save UUID to config file
*/
async function saveUUIDToConfig(uuid: string): Promise<void> {
  try {
    const config: Config = { uuid };
    await Deno.writeTextFile(CONFIG_FILE, JSON.stringify(config, null, 2));
    console.log(`💾 Saved UUID to config: ${uuid}`);
  } catch (e) {
    console.error(`❌ Failed to save UUID: ${e.message}`);
  }
}

// Determine UUID to use
let userID: string;

if (envUUID && isValidUUID(envUUID)) {
  userID = envUUID;
  console.log(`🔑 Using UUID from environment: ${userID}`);
} else {
  const configUUID = await getUUIDFromConfig();
  if (configUUID) {
    userID = configUUID;
  } else {
    userID = crypto.randomUUID();
    console.log(`🎲 Generated new UUID: ${userID}`);
    await saveUUIDToConfig(userID);
  }
}

if (!isValidUUID(userID)) {
  throw new Error('❌ Invalid UUID format');
}

console.log(`🚀 Deno ${Deno.version.deno}`);
console.log(`🔑 Final UUID: ${userID}`);

// WebSocket states
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

/**
* Safe WebSocket close
*/
function safeCloseWebSocket(socket: WebSocket): void {
  try {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
      socket.close();
    }
  } catch (error) {
    console.error('WebSocket close error:', error);
  }
}

/**
* Base64 to ArrayBuffer
*/
function base64ToArrayBuffer(base64Str: string): { earlyData?: ArrayBuffer; error?: Error } {
  if (!base64Str) return {};
  try {
    base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const decode = atob(base64Str);
    const arrayBuffer = Uint8Array.from(decode, c => c.charCodeAt(0));
    return { earlyData: arrayBuffer.buffer };
  } catch (error) {
    return { error };
  }
}

/**
* UUID stringify from bytes
*/
function stringifyUUID(arr: Uint8Array, offset = 0): string {
  const byteToHex: string[] = [];
  for (let i = 0; i < 256; ++i) {
    byteToHex.push((i + 256).toString(16).slice(1));
  }
  
  const uuid = (
    byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] +
    byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + '-' +
    byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + '-' +
    byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + '-' +
    byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + '-' +
    byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] +
    byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] +
    byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]
  ).toLowerCase();
  
  if (!isValidUUID(uuid)) {
    throw new TypeError('Invalid UUID');
  }
  return uuid;
}

/**
* Process VLESS header
*/
function processVlessHeader(
  vlessBuffer: ArrayBuffer, 
  userID: string
): {
  hasError: boolean;
  message?: string;
  addressRemote?: string;
  addressType?: number;
  portRemote?: number;
  rawDataIndex?: number;
  vlessVersion?: Uint8Array;
  isUDP?: boolean;
} {
  if (vlessBuffer.byteLength < 24) {
    return { hasError: true, message: 'Invalid data length' };
  }

  const version = new Uint8Array(vlessBuffer.slice(0, 1));
  const uuidBytes = new Uint8Array(vlessBuffer.slice(1, 17));
  
  if (stringifyUUID(uuidBytes) !== userID) {
    return { hasError: true, message: 'Invalid user' };
  }

  const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
  const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];

  let isUDP = false;
  if (command === 1) {
    // TCP
  } else if (command === 2) {
    isUDP = true;
  } else {
    return { hasError: true, message: `Unsupported command: ${command}` };
  }

  const portIndex = 18 + optLength + 1;
  const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
  const portRemote = new DataView(portBuffer).getUint16(0);

  let addressIndex = portIndex + 2;
  const addressBuffer = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1));
  const addressType = addressBuffer[0];
  
  let addressLength = 0;
  let addressValueIndex = addressIndex + 1;
  let addressValue = '';

  switch (addressType) {
    case 1: // IPv4
      addressLength = 4;
      addressValue = new Uint8Array(
        vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      ).join('.');
      break;
    case 2: // Domain
      addressLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
      addressValueIndex += 1;
      addressValue = new TextDecoder().decode(
        vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      );
      break;
    case 3: // IPv6
      addressLength = 16;
      const dataView = new DataView(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      const ipv6: string[] = [];
      for (let i = 0; i < 8; i++) {
        ipv6.push(dataView.getUint16(i * 2).toString(16));
      }
      addressValue = ipv6.join(':');
      break;
    default:
      return { hasError: true, message: `Invalid address type: ${addressType}` };
  }

  if (!addressValue) {
    return { hasError: true, message: 'Empty address' };
  }

  return {
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    vlessVersion: version,
    isUDP
  };
}

/**
* Create readable WebSocket stream
*/
function makeReadableWebSocketStream(
  webSocketServer: WebSocket,
  earlyDataHeader: string,
  log: (info: string, event?: string) => void
): ReadableStream {
  let readableStreamCancel = false;

  return new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener('message', (event) => {
        if (readableStreamCancel) return;
        controller.enqueue(event.data);
      });

      webSocketServer.addEventListener('close', () => {
        safeCloseWebSocket(webSocketServer);
        if (!readableStreamCancel) {
          controller.close();
        }
      });

      webSocketServer.addEventListener('error', (err) => {
        log('WebSocket error');
        controller.error(err);
      });

      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
    },

    cancel(reason) {
      if (readableStreamCancel) return;
      log(`Stream canceled: ${reason}`);
      readableStreamCancel = true;
      safeCloseWebSocket(webSocketServer);
    }
  });
}

/**
* Handle TCP outbound
*/
async function handleTCPOutBound(
  remoteSocket: { value: Deno.TcpConn | null },
  addressRemote: string,
  portRemote: number,
  rawClientData: Uint8Array,
  webSocket: WebSocket,
  vlessResponseHeader: Uint8Array,
  log: (info: string, event?: string) => void
): Promise<void> {
  async function connectAndWrite(address: string, port: number): Promise<Deno.TcpConn> {
    const tcpSocket = await Deno.connect({
      hostname: address,
      port: port
    });
    
    remoteSocket.value = tcpSocket;
    log(`Connected to ${address}:${port}`);
    
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();
    
    return tcpSocket;
  }

  async function retry(): Promise<void> {
    const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
    remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
  }

  const tcpSocket = await connectAndWrite(addressRemote, portRemote);
  remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
}

/**
* Forward remote socket to WebSocket
*/
async function remoteSocketToWS(
  remoteSocket: Deno.TcpConn,
  webSocket: WebSocket,
  vlessResponseHeader: Uint8Array,
  retry: (() => Promise<void>) | null,
  log: (info: string, event?: string) => void
): Promise<void> {
  let hasIncomingData = false;

  await remoteSocket.readable.pipeTo(
    new WritableStream({
      async write(chunk) {
        hasIncomingData = true;
        
        if (webSocket.readyState !== WS_READY_STATE_OPEN) {
          throw new Error('WebSocket not open');
        }

        if (vlessResponseHeader.length > 0) {
          const combined = new Uint8Array(vlessResponseHeader.length + chunk.length);
          combined.set(vlessResponseHeader);
          combined.set(chunk, vlessResponseHeader.length);
          webSocket.send(combined);
          vlessResponseHeader = new Uint8Array(0);
        } else {
          webSocket.send(chunk);
        }
      },
      
      close() {
        log(`Remote connection closed. Had data: ${hasIncomingData}`);
      },
      
      abort(reason) {
        log(`Remote connection aborted: ${reason}`);
      }
    })
  ).catch(error => {
    log(`Remote to WS error: ${error}`);
    safeCloseWebSocket(webSocket);
  });

  if (!hasIncomingData && retry) {
    log('Retrying connection...');
    retry();
  }
}

/**
* Handle UDP outbound
*/
async function handleUDPOutBound(
  webSocket: WebSocket,
  vlessResponseHeader: Uint8Array,
  log: (info: string) => void
): Promise<{ write: (chunk: Uint8Array) => void }> {
  let isVlessHeaderSent = false;

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      for (let index = 0; index < chunk.byteLength;) {
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPacketLength = new DataView(lengthBuffer).getUint16(0);
        const udpData = new Uint8Array(
          chunk.slice(index + 2, index + 2 + udpPacketLength)
        );
        index = index + 2 + udpPacketLength;
        controller.enqueue(udpData);
      }
    }
  });

  transformStream.readable.pipeTo(
    new WritableStream({
      async write(chunk) {
        try {
          const resp = await fetch('https://1.1.1.1/dns-query', {
            method: 'POST',
            headers: {
              'content-type': 'application/dns-message',
            },
            body: chunk,
          });

          const dnsQueryResult = await resp.arrayBuffer();
          const udpSize = dnsQueryResult.byteLength;
          const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);

          if (webSocket.readyState === WS_READY_STATE_OPEN) {
            log(`DNS query successful, length: ${udpSize}`);
            
            if (isVlessHeaderSent) {
              webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
            } else {
              webSocket.send(
                await new Blob([vlessResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer()
              );
              isVlessHeaderSent = true;
            }
          }
        } catch (error) {
          log(`DNS query failed: ${error}`);
        }
      }
    })
  ).catch(error => {
    log(`DNS UDP error: ${error}`);
  });

  const writer = transformStream.writable.getWriter();

  return {
    write(chunk: Uint8Array) {
      writer.write(chunk);
    }
  };
}

/**
* VLESS over WebSocket handler
*/
async function vlessOverWSHandler(request: Request): Promise<Response> {
  const { socket, response } = Deno.upgradeWebSocket(request);
  
  let address = '';
  let portWithRandomLog = '';
  
  const log = (info: string, event = '') => {
    console.log(`[${address}:${portWithRandomLog}] ${info}`, event);
  };

  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableWebSocketStream = makeReadableWebSocketStream(socket, earlyDataHeader, log);
  
  let remoteSocketWrapper = { value: null as Deno.TcpConn | null };
  let udpStreamWrite: ((chunk: Uint8Array) => void) | null = null;
  let isDns = false;

  readableWebSocketStream.pipeTo(
    new WritableStream({
      async write(chunk) {
        if (isDns && udpStreamWrite) {
          return udpStreamWrite(new Uint8Array(chunk));
        }

        if (remoteSocketWrapper.value) {
          const writer = remoteSocketWrapper.value.writable.getWriter();
          await writer.write(new Uint8Array(chunk));
          writer.releaseLock();
          return;
        }

        const result = processVlessHeader(chunk, userID);
        
        if (result.hasError) {
          throw new Error(result.message);
        }

        const {
          portRemote = 443,
          addressRemote = '',
          rawDataIndex,
          vlessVersion = new Uint8Array([0, 0]),
          isUDP = false,
        } = result;

        address = addressRemote;
        portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '}`;

        if (isUDP) {
          if (portRemote === 53) {
            isDns = true;
          } else {
            throw new Error('UDP proxy only enabled for DNS (port 53)');
          }
        }

        const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
        const rawClientData = new Uint8Array(chunk.slice(rawDataIndex!));

        if (isDns) {
          const { write } = await handleUDPOutBound(socket, vlessResponseHeader, log);
          udpStreamWrite = write;
          udpStreamWrite(rawClientData);
          return;
        }

        handleTCPOutBound(
          remoteSocketWrapper,
          addressRemote!,
          portRemote,
          rawClientData,
          socket,
          vlessResponseHeader,
          log
        );
      },

      close() {
        log('WebSocket stream closed');
      },

      abort(reason) {
        log('WebSocket stream aborted', JSON.stringify(reason));
      }
    })
  ).catch(err => {
    log('Stream error', err);
  });

  return response;
}

/**
* Generate Clash Meta Config
*/
function generateClashConfig(hostName: string): string {
  return `# Clash Meta Configuration for ${credit}
# ဒီ Link ကို Clash Meta မှာ တန်းထည့်သုံးလို့ရပါတယ်
# Generated at: ${new Date().toISOString()}

# HTTP/SOCKS Ports
mixed-port: 7890
socks-port: 7891
redir-port: 7892
allow-lan: true
mode: Rule
log-level: info
external-controller: 127.0.0.1:9090
secret: ""

# Proxies
proxies:
  - name: "🇸🇬 ${credit} - SG"
    type: vless
    server: ${hostName}
    port: 443
    uuid: ${userID}
    network: ws
    tls: true
    udp: true
    servername: ${hostName}
    client-fingerprint: chrome
    ws-opts:
      path: "/?ed=2048"
      headers:
        Host: ${hostName}

  - name: "🇸🇬 ${credit} - No TLS (Test)"
    type: vless
    server: ${hostName}
    port: 80
    uuid: ${userID}
    network: ws
    tls: false
    udp: true
    ws-opts:
      path: "/?ed=2048"
      headers:
        Host: ${hostName}

# Proxy Groups
proxy-groups:
  - name: "🚀 Proxy Selection"
    type: select
    proxies:
      - "🇸🇬 ${credit} - SG"
      - "🇸🇬 ${credit} - No TLS (Test)"
      - "🎯 DIRECT"
      - "🌍 Auto"

  - name: "🌍 Auto"
    type: url-test
    proxies:
      - "🇸🇬 ${credit} - SG"
    url: "http://www.gstatic.com/generate_204"
    interval: 300
    tolerance: 50

  - name: "🎯 DIRECT"
    type: select
    proxies:
      - DIRECT

# Rules
rules:
  # Local Network
  - IP-CIDR,192.168.0.0/16,DIRECT
  - IP-CIDR,10.0.0.0/8,DIRECT
  - IP-CIDR,172.16.0.0/12,DIRECT
  - IP-CIDR,127.0.0.0/8,DIRECT
  
  # Myanmar Sites
  - DOMAIN-SUFFIX,com.mm,DIRECT
  - DOMAIN-SUFFIX,net.mm,DIRECT
  - DOMAIN-SUFFIX,org.mm,DIRECT
  - DOMAIN-SUFFIX,edu.mm,DIRECT
  - DOMAIN-SUFFIX,gov.mm,DIRECT
  - DOMAIN-SUFFIX,mpt.com.mm,DIRECT
  - DOMAIN-SUFFIX,ooredoo.com.mm,DIRECT
  - DOMAIN-SUFFIX,telenor.com.mm,DIRECT
  - DOMAIN-SUFFIX,myanmar.com,DIRECT
  
  # Streaming
  - DOMAIN-SUFFIX,youtube.com,🚀 Proxy Selection
  - DOMAIN-SUFFIX,googlevideo.com,🚀 Proxy Selection
  - DOMAIN-SUFFIX,youtu.be,🚀 Proxy Selection
  - DOMAIN-SUFFIX,netflix.com,🚀 Proxy Selection
  - DOMAIN-SUFFIX,netflix.net,🚀 Proxy Selection
  - DOMAIN-SUFFIX,nflxvideo.net,🚀 Proxy Selection
  - DOMAIN-SUFFIX,spotify.com,🚀 Proxy Selection
  - DOMAIN-SUFFIX,applemusic.com,🚀 Proxy Selection
  
  # Social Media
  - DOMAIN-SUFFIX,facebook.com,🚀 Proxy Selection
  - DOMAIN-SUFFIX,fbcdn.net,🚀 Proxy Selection
  - DOMAIN-SUFFIX,instagram.com,🚀 Proxy Selection
  - DOMAIN-SUFFIX,cdninstagram.com,🚀 Proxy Selection
  - DOMAIN-SUFFIX,tiktok.com,🚀 Proxy Selection
  - DOMAIN-SUFFIX,tiktokcdn.com,🚀 Proxy Selection
  - DOMAIN-SUFFIX,twitter.com,🚀 Proxy Selection
  - DOMAIN-SUFFIX,x.com,🚀 Proxy Selection
  - DOMAIN-SUFFIX,telegram.org,🚀 Proxy Selection
  - DOMAIN-SUFFIX,whatsapp.com,🚀 Proxy Selection
  
  # Google
  - DOMAIN-SUFFIX,google.com,🚀 Proxy Selection
  - DOMAIN-SUFFIX,googleapis.com,🚀 Proxy Selection
  - DOMAIN-SUFFIX,gstatic.com,🚀 Proxy Selection
  - DOMAIN-SUFFIX,ggpht.com,🚀 Proxy Selection
  
  # AI & Dev
  - DOMAIN-SUFFIX,openai.com,🚀 Proxy Selection
  - DOMAIN-SUFFIX,chat.openai.com,🚀 Proxy Selection
  - DOMAIN-SUFFIX,anthropic.com,🚀 Proxy Selection
  - DOMAIN-SUFFIX,claude.ai,🚀 Proxy Selection
  - DOMAIN-SUFFIX,github.com,🚀 Proxy Selection
  - DOMAIN-SUFFIX,gitlab.com,🚀 Proxy Selection
  - DOMAIN-SUFFIX,stackoverflow.com,🚀 Proxy Selection
  
  # Cloudflare
  - DOMAIN-SUFFIX,cloudflare.com,🚀 Proxy Selection
  - DOMAIN-SUFFIX,cloudflareinsights.com,🚀 Proxy Selection
  
  # IP Test
  - DOMAIN-KEYWORD,ip,🚀 Proxy Selection
  - DOMAIN-SUFFIX,ipify.org,🚀 Proxy Selection
  - DOMAIN-SUFFIX,ipinfo.io,🚀 Proxy Selection
  
  # China Sites
  - GEOIP,CN,DIRECT
  - DOMAIN-SUFFIX,cn,DIRECT
  - DOMAIN-SUFFIX,baidu.com,DIRECT
  - DOMAIN-SUFFIX,qq.com,DIRECT
  - DOMAIN-SUFFIX,taobao.com,DIRECT
  
  # Default
  - MATCH,🚀 Proxy Selection

# ဒီ Config ကို Clash Meta မှာထည့်သုံးနည်း
# 1. Clash Meta ဖွင့်ပါ
# 2. Profiles → + → New Profile
# 3. Type: Remote ရွေးပါ
# 4. URL: https://${hostName}/clash ထည့်ပါ
# 5. Save နှိပ်ပါ
`;
}

/**
* Main server
*/
Deno.serve(async (request: Request) => {
  const upgrade = request.headers.get('upgrade') || '';
  
  if (upgrade.toLowerCase() !== 'websocket') {
    const url = new URL(request.url);
    const hostName = request.headers.get('host') || url.hostname;
    
    switch (url.pathname) {
      case '/':
        return new Response(`
          <html>
            <head><title>VLESS Server</title></head>
            <body style="font-family: Arial; text-align: center; margin-top: 50px;">
              <h1>🚀 VLESS Server is Running</h1>
              <p>UUID: <code>${userID}</code></p>
              <p>Host: <code>${hostName}</code></p>
              <p>Clash Meta Link: <a href="/clash">${hostName}/clash</a></p>
              <p>ဒီ Link ကို Clash Meta မှာ တန်းထည့်သုံးလို့ရပါတယ်။</p>
            </body>
          </html>
        `, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });

      case '/clash':
        const clashConfig = generateClashConfig(hostName);
        return new Response(clashConfig, {
          headers: { 
            'Content-Type': 'text/plain; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache'
          }
        });

      default:
        if (url.pathname === '/ws' || url.pathname === '/') {
          return await vlessOverWSHandler(request);
        }
        return new Response('Not Found', { status: 404 });
    }
  } else {
    return await vlessOverWSHandler(request);
  }
});

console.log(`🚀 Server started`);
console.log(`🔑 UUID: ${userID}`);
console.log(`📋 Clash Meta Link: http://localhost:8000/clash`);
console.log(`📱 ဒီ Link ကို Clash Meta မှာ တန်းထည့်သုံးလို့ရပါတယ်`);
