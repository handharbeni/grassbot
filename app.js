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
const grass_token = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IkJseGtPeW9QaWIwMlNzUlpGeHBaN2JlSzJOSEJBMSJ9.eyJ1c2VySWQiOiIyb0ZQQ3h1TEI5TU5rWlg4eVVZaklCMnI3MVQiLCJlbWFpbCI6Im1oYW5kaGFyYmVuaUBnbWFpbC5jb20iLCJzY29wZSI6IlVTRVIiLCJpYXQiOjE3MzE3MzI5ODksIm5iZiI6MTczMTczMjk4OSwiZXhwIjoxNzYyODM2OTg5LCJhdWQiOiJ3eW5kLXVzZXJzIiwiaXNzIjoiaHR0cHM6Ly93eW5kLnMzLmFtYXpvbmF3cy5jb20vcHVibGljIn0.UrLPKHWNpsE-VMvIxJHS4rr3_jiVf9aHRsy3SdOc2Az3v3o-m45k2vjiq0PePDZj48J0PDJkNf3fMytoQtcknNAQWVxdJtF4BkWIIvXoHPDHBZn2PJLzNeSnBJ-bZCEiZzKnGsyxKKlZK0qpwhfhMYZT7VF6nElW0et3Q9Een-Bv06Bf4dNkyAjJrDbYQzhbVMGJlPOgGSf0o-p8z5Q7PsKYNTxQBC1eO1TIwc7cAj5tuZ7OR4w76wIuwRQJnrut1RvZAVm2vWQuYO8c2nvZgRjcfQg-7ZcvxAXCDHhjdcihDoI9defo6-9nhf225K4oOxxVhAgGHqSjfSTAFHcb9g";
const MAX_CONNECTIONS = 1000; // Lower initial max connections to reduce CPU load
const RELOAD_INTERVAL = 5 * 60 * 1000; // 5 minutes
const MIN_SUCCESS_RATE = 0.15; // 40%
const MAX_RETRIES = 5; // Max retry attempts per proxy
const PERCENTAGE_RELOAD = 0.4; // ratio activehandle need more than 40% to continue the process
const PROXY_SOURCES_FILE = 'proxy_sources.txt';
const WORKING_PROXIES_FILE = 'working_proxies.txt';
const ipRegex = /(?:socks[45]|http|https):\/\/([\d.]+):\d+/;

let uniqueResults = new Map();
let workingProxies = new Set();
let failedProxies = new Set();
let totalProxies = new Set();
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
    totalProxies = new Set();
    try {
        const response = await axios.get(url);
        const proxyList = response.data.split('\n').map(line => line.trim()).filter(line => line);

        proxyList.forEach(proxy => {
            newProxies.add(prefix + proxy);
            totalProxies.add(prefix + proxy);
        });

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
        eliminateScore(ws, socksProxy);
    });

    ws.on('message', (message) => handleWebSocketMessage(message, ws, socksProxy, userId, deviceId, userAgent));

    ws.on('error', (error) => handleProxyFailure(socksProxy, error));

    ws.on('close', () => handleProxyFailure(socksProxy, 'closed connection'));


}

function eliminateScore(ws, proxy) {
    let extractedProxy = extractProxy(proxy);
    let proxyIsExist = uniqueResults.get(extractedProxy);
    if (proxyIsExist !== undefined) {
        if (proxyIsExist < 75) {
            disconnectWS(ws);
        } else {
            schedulePing(ws, proxy);
        }
    } else {
        schedulePing(ws, proxy);
    }
}

function getScore(ws, proxy) {
    let extractedProxy = extractProxy(proxy);
    let proxyIsExist = uniqueResults.get(extractedProxy);
    if (proxyIsExist !== undefined) {
        return proxyIsExist;
    } else {
        return -1;
    }
}

function disconnectWS(ws, reason = 'Score below threshold') {
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log(`Disconnecting WebSocket: ${reason}`);
        ws.close(1000, reason); // Normal closure
    }
}

function sendPing(ws, socksProxy, intervalId = -1) {
    const pingMsg = JSON.stringify({ id: uuid.v4(), version: "1.0.0", action: "PING", data: {} });
    ws.send(pingMsg);
    console.log(`Sent PING through ${socksProxy} intervalId ${intervalId}`);
    if (intervalId !== -1) {
        let score = getScore(ws, socksProxy);
        if (score < 75) {
            disconnectWS(ws, socksProxy);
            clearInterval(intervalId);
        }
    }
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
    const intervalId = setInterval(() => {
        sendPing(ws, socksProxy, intervalId);
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

// check active handle
function checkActiveHandle() {
    const activeRequests = process._getActiveRequests().length;
    const activeHandlesCount = process._getActiveHandles().length;
    const percentage = ((activeHandlesCount / totalProxies.size) * 100) / 100;
    console.log(`activeRequest ${activeRequests}, activeHandle ratio (${activeHandlesCount} / ${totalProxies.size}) * 100% = ${percentage}`);
    if ((percentage < PERCENTAGE_RELOAD) && activeRequests < 10) {
        reloadProxies()
    }
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function extractProxy(proxy) {
    const match = proxy.match(ipRegex);
    return match ? match[1] : null;
}

// Reload proxies based on success rate and refresh strategy
async function reloadProxies() {
    // const successRate = proxySuccessCount / (proxySuccessCount + proxyFailCount);
    // if (successRate < MIN_SUCCESS_RATE) {
    // }
    // console.log("Low success rate detected. Reloading proxies from a new source...");
    const newProxies = await fetchProxiesFromRandomSource();
    newProxies.forEach(proxy => {
        if (!failedProxies.has(proxy)) connectionQueue.push(proxy);
    });
    proxySuccessCount = 0;
    proxyFailCount = 0;
}

// Function to fetch data with pagination
async function fetchDevices(limit, pk, sk) {
    try {
        pk = encodeURIComponent(pk);
        sk = encodeURIComponent(sk);
        const response = await axios.get(`https://api.getgrass.io/devices?input=%7B%22limit%22:${limit},%22lastEvaluationKey%22:%7B%22pk%22:%22${pk}%22,%22sk%22:%22${sk}%22%7D%7D`, {
            headers: {
                'Authorization': `${grass_token}`
            }
        });

        // Extract data from the response
        const result = response.data.result;
        if (result && result.data) {
            const devices = result.data.data;
            const lastEvaluationKey = result.data.lastEvaluationKey;

            devices.forEach(device => {
                const { ipAddress, ipScore } = device;
                uniqueResults.set(ipAddress, ipScore);
            });
            return lastEvaluationKey;
        } else {
            return null;
        }
    } catch (error) {
        return null;
    }
};


async function fetchAllDevices() {
    const limit = 10;
    let pk = null;
    let sk = null;
    let hasMore = true;

    while (hasMore) {
        const lastEvaluationKey = await fetchDevices(limit, pk, sk);
        console.log(`Fetching Devices ${pk} ${sk}`);
        if (lastEvaluationKey) {
            pk = lastEvaluationKey.pk;
            sk = lastEvaluationKey.sk;
        } else {
            hasMore = false;
        }
    }
}
// Main loop
async function main() {
    fetchAllDevices();

    await wait(1 * 60 * 1000);

    setInterval(fetchAllDevices, (2 * 60 * 1000));

    const initialProxies = await fetchProxiesFromRandomSource();
    initialProxies.forEach(proxy => connectionQueue.push(proxy));

    await wait(1 * 60 * 1000);

    setInterval(() => {
        checkActiveHandle();
    }, 10 * 1000);
}

main().catch(console.error);
