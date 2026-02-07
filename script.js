// --- CONFIGURATION ---
const API_URL = "https://np-api.monerod.org";
const BONUS_API = "https://bonus-api.monerod.org/2/summary";
const COIN_API = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=USD&ids=monero&order=market_cap_desc&per_page=1&page=1&sparkline=false&price_change_percentage=1h";
const CACHE_KEY = "monero_miner_address";

// Worker Colors Palette (Bright & Distinct)
const WORKER_COLORS = [
    '#ffb700', // Yellow
    '#00d2d3', // Cyan
    '#5f27cd', // Purple
    '#ff9f43', // Orange-ish
    '#54a0ff', // Blue
    '#ff6b6b'  // Red
];

const appState = {
    address: localStorage.getItem(CACHE_KEY) || null,
    netStats: {},
    poolStats: {},
    poolBlocks: [],
    minerStats: {},
    poolChartInstance: null,
    minerChartInstance: null,
    fiatPrice: 0,
    minPayout: 0.003
};

// --- INITIALIZATION ---
document.addEventListener("DOMContentLoaded", () => {
    document.getElementById('year').textContent = new Date().getFullYear();
    updateAuthView();
    refreshData();
    setInterval(refreshData, 60000); // 60s poll
});

async function refreshData() {
    try {
        await Promise.all([
            fetchNetworkStats(),
            fetchPoolStats(),
            fetchConfig()
        ]);
        if (appState.address) {
            await fetchMinerData();
        }
    } catch (e) {
        console.error("Data update error:", e);
    }
}

// --- API FETCHING ---

async function fetchConfig() {
    try {
        const res = await fetch(`${API_URL}/config`);
        const data = await res.json();
        if(data.min_wallet_payout) {
            appState.minPayout = data.min_wallet_payout / 1e12;
            document.getElementById('min-payout-val').innerText = appState.minPayout;
        }
    } catch(e) {}
}

async function fetchNetworkStats() {
    const res = await fetch(`${API_URL}/network/stats`);
    const data = await res.json();
    appState.netStats = data;

    setText('net-hash', formatHashrate(data.difficulty / 120));
    setText('net-diff', data.difficulty.toLocaleString());
    setText('net-height', data.height.toLocaleString());
    setText('net-reward', formatXMR(data.value));
    setText('net-last', timeAgo(data.ts));

    fetchCoinPrice();
}

async function fetchCoinPrice() {
    try {
        const res = await fetch(COIN_API);
        const data = await res.json();
        if(data && data[0]) {
            appState.fiatPrice = data[0].current_price;
            setText('net-price', `$${appState.fiatPrice.toFixed(2)}`);
        }
    } catch(e) { /* Limit hit */ }
}

async function fetchPoolStats() {
    const res = await fetch(`${API_URL}/pool/stats`);
    const data = await res.json();
    const stats = data.pool_statistics;
    appState.poolStats = stats;

    setText('pool-hash-display', formatHashrate(stats.hashRate));
    setText('pool-hash', formatHashrate(stats.hashRate));
    setText('pool-miners', stats.miners);
    setText('pool-blocks', stats.totalBlocksFound);

    // Effort: roundHashes / networkDifficulty
    const effort = appState.netStats.difficulty ? ((stats.roundHashes / appState.netStats.difficulty) * 100).toFixed(2) + '%' : '---';
    setText('pool-effort', effort);

    setText('pool-payments', `${stats.totalPayments} / ${stats.totalMinersPaid}`);
    setText('pool-pplns', (stats.pplnsWindowTime / 3600).toFixed(1) + 'h');

    // Network Share
    const netH = appState.netStats.difficulty / 120;
    const share = ((stats.hashRate / netH) * 100).toFixed(3) + '%';
    setText('pool-share', share);

    // Boost
    try {
        const bRes = await fetch(BONUS_API);
        const bData = await bRes.json();
        const boostH = bData.hashrate.total[1] * 1000;
        setText('pool-boost', formatHashrate(boostH));
    } catch (e) { setText('pool-boost', '0 H/s'); }

    // Chart & Modals
    await loadPoolBlocks();
    loadPoolPayments();
    fetchPoolChart();
}

async function fetchPoolChart() {
    try {
        const res = await fetch(`${API_URL}/pool/chart/hashrate`);
        const data = await res.json(); // [[ts, hashrate], ...]
        if(data) {
            renderPoolChart(data, appState.poolBlocks);
        }
    } catch(e) { console.error("Pool chart fail", e); }
}

async function fetchMinerData() {
    const addr = appState.address;
    try {
        // 1. Fetch Primary Stats
        const statsRes = await fetch(`${API_URL}/miner/${addr}/stats`);
        const stats = await statsRes.json();
        appState.minerStats = stats;

        // 2. Fetch User Settings (Threshold/Email)
        const userRes = await fetch(`${API_URL}/user/${addr}`);
        const user = await userRes.json();
        const threshold = user.payout_threshold / 1e12;

        // 3. Fetch Worker List
        const wRes = await fetch(`${API_URL}/miner/${addr}/identifiers`);
        const workers = await wRes.json();

        // Data Prep
        const pending = stats.amtDue / 1e12;
        const paid = stats.amtPaid / 1e12;
        const minerHash = stats.hash || 0;
        const netDiff = appState.netStats.difficulty || 0;
        const netReward = appState.netStats.value || 0;
        const windowSeconds = appState.poolStats.pplnsWindowTime || 21600; // Default 6h

        // Update basic UI fields
        setText('miner-hash-display', formatHashrate(minerHash));
        setText('miner-balance', pending.toFixed(6) + ' XMR');
        setText('miner-paid', paid.toFixed(6) + ' XMR');
        setText('miner-threshold-display', threshold.toFixed(3));

        if (appState.fiatPrice) {
            setText('miner-fiat', `≈ $${(paid * appState.fiatPrice).toFixed(2)} USD`);
        }

        // Progress Bar
        const pct = Math.min((pending / threshold) * 100, 100);
        document.getElementById('payout-progress').style.width = pct + '%';

        // Boost Status
        const isBoosting = workers.includes("MonerodBoost");
        document.getElementById('boost-status').classList.toggle('hidden', !isBoosting);

        // --- FIXED ESTIMATED EARNINGS CALCULATION ---
        /**
         * Formula: (Miner Hash / Network Hash) * Blocks in Window * Block Reward
         * Network Hash = Difficulty / 120 (Target block time)
         * Blocks in Window = Window Duration (sec) / 120
         */
        if (minerHash > 0 && netDiff > 0 && netReward > 0) {
            const networkHash = netDiff / 120;
            const blocksInWindow = windowSeconds / 120;
            const blockRewardXMR = netReward / 1e12;

            // Expected earnings = your portion of the network * total blocks produced * reward
            const estEarnings = (minerHash / networkHash) * blocksInWindow * blockRewardXMR;

            setText('miner-calc', `~${estEarnings.toFixed(6)} XMR`);
        } else {
            setText('miner-calc', '---');
        }

        document.getElementById('miner-shares').innerText = `${stats.validShares} / ${stats.invalidShares}`;

        // Fetch and Render Miner Chart
        const cRes = await fetch(`${API_URL}/miner/${addr}/chart/hashrate/allWorkers`);
        const cData = await cRes.json();
        renderMinerChart(cData);

        // Render Lists
        renderWorkerList(addr, workers);
        loadMinerPayments(addr);
        loadMinerBlocks(addr);

    } catch (e) {
        console.error("Error updating miner dashboard:", e);
    }
}

// --- RENDERING CHARTS ---

function renderPoolChart(hashrateData, blockList) {
    const canvas = document.getElementById('poolChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if(appState.poolChartInstance) appState.poolChartInstance.destroy();

    // 1. Calculate 24h Cutoff
    const now = Date.now();
    const twentyFourHoursAgo = now - (24 * 60 * 60 * 1000);

    // 2. Filter and Sort Hashrate Data (only last 24h)
    const linePoints = hashrateData
        .filter(d => d.ts >= twentyFourHoursAgo) // Strip old data
        .map(d => ({ x: d.ts, y: d.hs }))
        .sort((a, b) => a.x - b.x);

    // 3. Filter and Map Block Data (only last 24h)
    let scatterPoints = [];
    if(blockList && blockList.length > 0) {
        scatterPoints = blockList
            .filter(b => (b.ts * 1000) >= twentyFourHoursAgo) // Filter blocks
            .map(b => {
                const bTime = b.ts * 1000;
                let closestY = 0;

                // Snap block dot to the line
                if(linePoints.length > 0) {
                    const closest = linePoints.reduce((prev, curr) =>
                        Math.abs(curr.x - bTime) < Math.abs(prev.x - bTime) ? curr : prev
                    );
                    closestY = closest.y;
                }

                return {
                    x: bTime,
                    y: closestY,
                    height: b.height,
                    effort: ((b.shares / b.diff) * 100).toFixed(0)
                };
            });
    }

    // 4. Create Gradient
    const gradient = ctx.createLinearGradient(0, 0, 0, 200);
    gradient.addColorStop(0, 'rgba(242, 104, 34, 0.5)');
    gradient.addColorStop(1, 'rgba(242, 104, 34, 0.0)');

    appState.poolChartInstance = new Chart(ctx, {
        data: {
            datasets: [
                {
                    type: 'line',
                    label: 'Hashrate',
                    data: linePoints,
                    borderColor: '#F26822',
                    backgroundColor: gradient,
                    borderWidth: 2,
                    fill: true,
                    pointRadius: 0,
                    pointHitRadius: 10,
                    tension: 0.4,
                    order: 2
                },
                {
                    type: 'scatter',
                    label: 'Blocks',
                    data: scatterPoints,
                    backgroundColor: '#fff',
                    borderColor: '#FFD700',
                    borderWidth: 2,
                    pointRadius: 6,
                    pointHoverRadius: 8,
                    pointStyle: 'rectRot',
                    order: 1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    callbacks: {
                        label: (ctx) => {
                            if(ctx.dataset.type === 'scatter') {
                                return `Block ${ctx.raw.height}: ${ctx.raw.effort}% Effort`;
                            }
                            return formatHashrate(ctx.parsed.y);
                        }
                    }
                }
            },
            scales: {
                x: {
                    type: 'time',
                    display: false,
                    min: twentyFourHoursAgo, // Force start of chart to 24h ago
                    max: now                 // Force end of chart to now
                },
                y: {
                    display: false,
                    min: 0,
                    // If hashrate is very high, this ensures the line isn't
                    // squashed at the very bottom or top
                    beginAtZero: true
                }
            }
        }
    });
}

function renderMinerChart(workersData) {
    const canvas = document.getElementById('minerChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (appState.minerChartInstance) appState.minerChartInstance.destroy();

    const datasets = [];
    const now = Date.now();
    const twentyFourHoursAgo = now - (24 * 60 * 60 * 1000);

    // Helper to process, filter, and sort each data series
    const processSeries = (data) => {
        if (!Array.isArray(data)) return [];
        return data
            .filter(d => d.ts >= twentyFourHoursAgo) // Filter for last 24h
            .map(d => ({ x: d.ts, y: d.hs }))        // Map Object properties
            .sort((a, b) => a.x - b.x);              // Sort Oldest -> Newest
    };

    // 1. Process the "global" series (The filled Teal area)
    if (workersData.global) {
        const globalPoints = processSeries(workersData.global);

        const gradient = ctx.createLinearGradient(0, 0, 0, 200);
            gradient.addColorStop(0, 'rgba(242, 104, 34, 0.5)');
            gradient.addColorStop(1, 'rgba(242, 104, 34, 0.0)');

        datasets.push({
            label: 'Total',
            data: globalPoints,
            borderColor: '#F26822',
            backgroundColor: gradient,
            borderWidth: 2,
            fill: true,
            pointRadius: 0,
            pointHitRadius: 10,
            tension: 0.4,
            order: 10 // Draw on bottom layer
        });
    }

    // 2. Process all individual workers (Bright colored lines)
    let colorIdx = 0;
    // Worker colors from our WORKER_COLORS palette
    Object.keys(workersData).forEach(key => {
        if (key === 'global') return; // Skip global as we handled it above

        const workerPoints = processSeries(workersData[key]);

        if (workerPoints.length > 0) {
            datasets.push({
                label: key,
                data: workerPoints,
                borderColor: WORKER_COLORS[colorIdx % WORKER_COLORS.length],
                borderWidth: 1.5,
                fill: false,
                pointRadius: 0,
                pointHitRadius: 10,
                tension: 0.4,
                order: 5 // Draw on top layer
            });
            colorIdx++;
        }
    });

    // 3. Construct the Chart
    appState.minerChartInstance = new Chart(ctx, {
        type: 'line',
        data: { datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'nearest',
                axis: 'x',
                intersect: false
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.dataset.label}: ${formatHashrate(ctx.parsed.y)}`
                    }
                }
            },
            scales: {
                x: {
                    type: 'time',
                    display: false,
                    min: twentyFourHoursAgo,
                    max: now,
                    grid: { display: false }
                },
                y: {
                    display: false,
                    grid: { display: false },
                    min: 0
                }
            }
        }
    });
}

// --- DATA HELPERS ---
async function renderWorkerList(addr, workerIds) {
    const tbody = document.getElementById('worker-list');
    tbody.innerHTML = '';
    const subset = workerIds.slice(0, 10);
    if(subset.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted">No active workers</td></tr>`;
        return;
    }
    const promises = subset.map(id => fetch(`${API_URL}/miner/${addr}/stats/${id}`).then(r => r.json()));
    const results = await Promise.all(promises);

    results.forEach((w, i) => {
        tbody.innerHTML += `
        <tr>
            <td>${subset[i] === "MonerodBoost" ? '<i class="fas fa-bolt text-success"></i> Boost' : subset[i]}</td>
            <td>${formatHashrate(w.hash)}</td>
            <td>${w.validShares}/${w.invalidShares}</td>
            <td>${w.totalHash}</td>
            <td>${timeAgo(w.lts)}</td>
        </tr>`;
    });
}

async function loadMinerPayments(addr) {
    const res = await fetch(`${API_URL}/miner/${addr}/payments`);
    const data = await res.json();
    const table = document.getElementById('miner-payments-list');
    table.innerHTML = '';
    if(!data.length) table.innerHTML = `<tr><td colspan="5" class="text-center text-muted">No payments yet</td></tr>`;
    data.slice(0,10).forEach(r => {
        table.innerHTML += `<tr>
            <td>1</td>
            <td>${formatXMR(r.amount)} XMR</td>
            <td>${formatXMR(r.fee || 0)} XMR</td>
            <td><a href="https://xmrchain.net/tx/${r.txnHash}" target="_blank"><i class="fas fa-external-link-alt"></i></a></td>
            <td>${formatDate(r.ts)}</td>
        </tr>`;
    });
}

async function loadMinerBlocks(addr) {
    const res = await fetch(`${API_URL}/miner/${addr}/block_payments`);
    const data = await res.json();
    const table = document.getElementById('miner-blocks-list');
    table.innerHTML = '';
    if(!data.length) table.innerHTML = `<tr><td colspan="5" class="text-center text-muted">No blocks found yet</td></tr>`;
    data.slice(0,10).forEach(r => {
        table.innerHTML += `<tr>
            <td>${formatXMR(r.value)} XMR</td>
            <td>${r.value_percent.toFixed(6)}%</td>
            <td><a href="https://xmrchain.net/block/${r.height}" target="_blank">${r.height}</a></td>
            <td>${formatDate(r.ts)}</td>
            <td>${formatDate(r.ts_found)}</td>
        </tr>`;
    });
}

async function loadPoolBlocks() {
    const res = await fetch(`${API_URL}/pool/blocks`);
    const data = await res.json();
    appState.poolBlocks = data; // Store for chart

    const table = document.getElementById('pool-blocks-table');
    table.innerHTML = '';
    data.slice(0,15).forEach(b => {
        let status = b.unlocked ? '<i class="fas fa-unlock text-success" title="Confirmed"></i>' : '<i class="fas fa-lock text-warning" title="Confirming"></i>';
        if(!b.valid) status = '<i class="fas fa-skull text-danger" title="Orphaned"></i>';
        let effort = (b.shares / b.diff) * 100;
        let effortClass = effort > 100 ? 'text-danger' : 'text-success';
        table.innerHTML += `<tr>
            <td><a href="https://xmrchain.net/block/${b.height}" target="_blank">${b.height}</a></td>
            <td>${status}</td>
            <td>${formatXMR(b.value)} XMR</td>
            <td><span class="${effortClass}">${effort.toFixed(2)}%</span></td>
            <td>${formatDate(b.ts/1000)}</td>
        </tr>`;
    });
}

async function loadPoolPayments() {
    const res = await fetch(`${API_URL}/pool/payments`);
    const data = await res.json();
    const table = document.getElementById('pool-payments-table');
    table.innerHTML = '';
    data.slice(0,15).forEach(p => {
        table.innerHTML += `<tr>
            <td>${p.payees}</td>
            <td>${formatXMR(p.value)} XMR</td>
            <td>${formatXMR(p.fee)} XMR</td>
            <td><a href="https://xmrchain.net/tx/${p.hash}" target="_blank"><i class="fas fa-circle-info"></i></a></td>
            <td>${formatDate(p.ts/1000)}</td>
        </tr>`;
    });
}

// --- SETTINGS ---
function saveThreshold() {
    const val = document.getElementById('setting-threshold').value;
    if(!val || val < appState.minPayout) {
        showToast("Invalid Amount");
        return;
    }
    const body = new URLSearchParams();
    body.append('username', appState.address);
    body.append('threshold', val);
    fetch(`${API_URL}/user/updateThreshold`, {method:'POST', body}).then(r=>r.json()).then(d=>{
        showToast(d.msg || "Error");
        if(!d.error) fetchMinerData();
    });
}

function saveEmail() {
    const from = document.getElementById('setting-email-from').value;
    const to = document.getElementById('setting-email-to').value;
    const en = document.getElementById('setting-email-enable').checked ? 1 : 0;
    const body = new URLSearchParams();
    body.append('username', appState.address);
    body.append('enabled', en);
    body.append('from', from);
    body.append('to', to);
    fetch(`${API_URL}/user/subscribeEmail`, {method:'POST', body}).then(r=>r.json()).then(d=>{
        showToast(d.msg || d.error || "Updated");
    });
}

// --- UTILS ---
function handleLogin() {
    const val = document.getElementById('walletInput').value.trim();
    if(val.length > 90) {
        localStorage.setItem(CACHE_KEY, val);
        appState.address = val;
        updateAuthView();
        fetchMinerData();
    } else {
        alert("Invalid Address");
    }
}

function updateAuthView() {
    const btn = document.getElementById('authBtn');
    if(appState.address) {
        btn.innerText = "Sign Out";
        btn.onclick = () => {
            localStorage.removeItem(CACHE_KEY);
            appState.address = null;
            location.reload();
        };
        document.getElementById('login-view').classList.add('hidden');
        document.getElementById('miner-view').classList.remove('hidden');
    } else {
        btn.innerText = "Sign In";
        btn.onclick = () => document.querySelector('.miner-section').scrollIntoView({behavior:'smooth'});
        document.getElementById('login-view').classList.remove('hidden');
        document.getElementById('miner-view').classList.add('hidden');
    }
}

function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    const idx = ['workers', 'payments', 'blocks', 'settings'].indexOf(tab);
    if(idx > -1) {
        document.querySelectorAll('.tab-btn')[idx].classList.add('active');
        document.querySelectorAll('.tab-content')[idx].classList.add('active');
    }
}

function setText(id, val) {
    const el = document.getElementById(id);
    if(el) el.innerText = val;
}
function formatHashrate(h) {
    if(!h) return '0 H/s';
    const i = Math.floor(Math.log(h)/Math.log(1000));
    return (h/Math.pow(1000,i)).toFixed(2) + ' ' + ['H/s','KH/s','MH/s','GH/s'][i];
}
function formatXMR(v) { return (v/1e12).toFixed(5); }
function formatDate(ts) { return new Date(ts*1000).toLocaleString(); }
function timeAgo(ts) {
    if(!ts) return '---';
    if(ts < 10000000000) ts *= 1000;
    const diff = (Date.now() - ts)/1000;
    if(diff<60) return Math.floor(diff)+'s ago';
    if(diff<3600) return Math.floor(diff/60)+'m ago';
    return Math.floor(diff/3600)+'h ago';
}

function openModal(id) { document.getElementById(id).style.display = 'block'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }
window.onclick = (e) => { if(e.target.classList.contains('modal')) e.target.style.display="none"; }
function showToast(msg) {
    const t = document.getElementById('toast');
    t.innerText = msg;
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 3000);
}
function copyDonate() {
    navigator.clipboard.writeText("8B6nMw5K64bKcejt17PfBsjMpANKuRsBU3FeStsru5fTZeCwVqQVebUfwjPeoM8WshiAg1a5x85RgYx2s3JzTRLsKdK1Q9C");
    showToast("Address Copied!");
}
