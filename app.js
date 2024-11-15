const fs = require('fs');
const WebSocket = require('ws');
const axios = require('axios');
const uuid = require('uuid');
const { queue } = require('async');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { HttpProxyAgent } = require('http-proxy-agent');
const UA = require('user-agents');

// Constants
const user_id = "2oFPCxuLB9MNkZX8yUYjIB2r71T";
const MAX_CONNECTIONS = 1000; // Lower initial max connections to reduce CPU load
const RELOAD_INTERVAL = 5 * 60 * 1000; // 5 minutes
const MIN_SUCCESS_RATE = 0.4; // 40%
const MAX_RETRIES = 5; // Max retry attempts per proxy
const PROXY_SOURCES_FILE = 'proxy_sources.txt';
const WORKING_PROXIES_FILE = 'working_proxies.txt';

let workingProxies = new Set();
let failedProxies = new Set();
let proxyRetryCount = {};
let proxySuccessCount = 0;
let proxyFailCount = 0;

function getProxyAgent(proxy) {
    if (proxy.startsWith('socks4://') || proxy.startsWith('socks5://')) {
        return new SocksProxyAgent(proxy);
    } else if (proxy.startsWith('http://')) {
        return new HttpProxyAgent(proxy);
    } else if (proxy.startsWith('https://')) {
        return new HttpsProxyAgent(proxy);
    } else {
        throw new Error(`Unsupported proxy type for proxy: ${proxy}`);
    }
}

// Read proxy sources from a file (cache it in memory)
async function getProxySources() {
    const sources = [];
    const data = fs.readFileSync(PROXY_SOURCES_FILE, 'utf-8').split('\n');

    data.forEach(line => {
        const [url, prefix] = line.split(',').map(item => item.trim());
        if (url) {
            sources.push({ url, prefix: prefix || '' });
        }
    });

    return sources;
}

// Fetch proxies from a randomly selected source
async function fetchProxiesFromRandomSource() {
    const sources = await getProxySources();
    const randomSource = sources[Math.floor(Math.random() * sources.length)];
    const { url, prefix } = randomSource;
    const newProxies = new Set();

    try {
        const response = await axios.get(url);
        const proxyList = response.data.split('\n').map(line => line.trim()).filter(line => line);

        proxyList.forEach(proxy => newProxies.add(prefix + proxy));

        console.log(`Fetched ${newProxies.size} proxies from ${url}`);
        return newProxies;
    } catch (error) {
        console.error(`Failed to fetch proxies from ${url}: ${error.message}`);
        return new Set();
    }
}

// Save working proxies to a file in batches to reduce I/O frequency
let saveWorkingProxiesTimeout;
function saveWorkingProxiesToFile() {
    if (saveWorkingProxiesTimeout) clearTimeout(saveWorkingProxiesTimeout);
    saveWorkingProxiesTimeout = setTimeout(() => {
        fs.writeFileSync(WORKING_PROXIES_FILE, Array.from(workingProxies).join('\n'), 'utf-8');
    }, 2000); // Batch write every 2 seconds
}

// Connection queue for managing WebSocket connections
const connectionQueue = queue(async (proxy) => {
    await connectToWSS(proxy, user_id);
}, MAX_CONNECTIONS);

// WebSocket connection using proxy
async function connectToWSS(socksProxy, userId) {
    // if (failedProxies.has(socksProxy)) return;

    const deviceId = uuid.v4();
    const userAgent = new UA({ deviceCategory: 'desktop' }).random().toString();
    const uri = ["wss://proxy2.wynd.network:4444/", "wss://proxy2.wynd.network:4650/"][Math.floor(Math.random() * 2)];
    const headers = { "User-Agent": userAgent };    
    const agent = getProxyAgent(socksProxy);  
    const wsOptions = { headers, agent };
    const ws = new WebSocket(uri, wsOptions);
    ws.on('open', () => {
        console.log(`Connected via ${socksProxy}`);
        sendPing(ws, socksProxy);
        schedulePing(ws, socksProxy);
    });

    ws.on('message', (message) => handleWebSocketMessage(message, ws, socksProxy, userId, deviceId, userAgent));

    ws.on('error', (error) => handleProxyFailure(socksProxy, error));

    ws.on('close', () => handleProxyFailure(socksProxy, 'closed connection'));
}

function sendPing(ws, socksProxy) {
    const pingMsg = JSON.stringify({ id: uuid.v4(), version: "1.0.0", action: "PING", data: {} });
    ws.send(pingMsg);
    console.log(`Sent PING through ${socksProxy}`);
}

// Handle WebSocket messages
function handleWebSocketMessage(message, ws, socksProxy, userId, deviceId, userAgent) {    
    const data = JSON.parse(message);
    if (data.action === "AUTH") {
        ws.send(JSON.stringify({
            id: data.id,
            origin_action: "AUTH",
            result: {
                browser_id: deviceId,
                user_id: userId,
                user_agent: userAgent,
                timestamp: Math.floor(Date.now() / 1000),
                device_type: "desktop",
                version: "4.28.2",
            }
        }));
    } else if (data.action === "PONG") {
        if (!workingProxies.has(socksProxy)) {
            workingProxies.add(socksProxy);
            console.log(`Added ${socksProxy} to working proxies. Total: ${workingProxies.size}`);
            saveWorkingProxiesToFile(); // Save in batch
        }
        const pongResponse = JSON.stringify({ id: data.id, origin_action: "PONG" });
        ws.send(pongResponse);
    }
}

// Schedule pings for active proxies every 2 minutes
function schedulePing(ws, socksProxy) {
    setInterval(() => {
        sendPing(ws, socksProxy);
    }, 3 * 1000); // Every 2 minutes
}

// Handle proxy failures and retries
function handleProxyFailure(socksProxy, error) {
    proxyRetryCount[socksProxy] = (proxyRetryCount[socksProxy] || 0) + 1;
    if (proxyRetryCount[socksProxy] > MAX_RETRIES) {
        failedProxies.add(socksProxy);
        workingProxies.delete(socksProxy);
    }
}

// Reload proxies based on success rate and refresh strategy
async function reloadProxies() {
    const successRate = proxySuccessCount / (proxySuccessCount + proxyFailCount);
    if (successRate < MIN_SUCCESS_RATE) {
        console.log("Low success rate detected. Reloading proxies from a new source...");
        const newProxies = await fetchProxiesFromRandomSource();
        newProxies.forEach(proxy => {
            if (!failedProxies.has(proxy)) connectionQueue.push(proxy);
        });
        proxySuccessCount = 0;
        proxyFailCount = 0;
    }
}

// Main loop
async function main() {
    const initialProxies = await fetchProxiesFromRandomSource();
    initialProxies.forEach(proxy => connectionQueue.push(proxy));

    setInterval(() => {
        reloadProxies();
    }, RELOAD_INTERVAL);
}

main().catch(console.error);
