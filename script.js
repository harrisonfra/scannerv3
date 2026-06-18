let allData = [];
let filteredData = [];
let currentSort = { key: null, asc: false };
let selectedItems = new Set();
// Part-interchange ranges (data/interchange.json) + the vehicle last scanned.
let interchange = [];
let scannedCtx = { make: "", model: "", year: null };

/* =========================
   THEME
========================= */
function applyTheme(light) {
    document.body.classList.toggle("light", light);
    localStorage.setItem("theme", light ? "light" : "dark");
}

// Respect the stored preference (default: light)
applyTheme(localStorage.getItem("theme") !== "dark");

document.getElementById("theme-btn").addEventListener("click", () => {
    applyTheme(!document.body.classList.contains("light"));
});

/* =========================
   LOAD DATA
========================= */
// Published by the hub's "Publish to Scanner" button (suite/publish.py).
fetch("data/all_data.json")
    .then(res => res.text())
    .then(text => {
        // The data generator emits bare NaN (invalid JSON). Only replace NaN
        // in value position (after : , or [) so strings containing "NaN" survive.
        const data = JSON.parse(text.replace(/([:,[]\s*)NaN(?=\s*[,\]}])/g, "$1null"));

        allData = data.map(item => ({
            ...item,
            Make:  item.Make  || "",
            Model: item.Model || "",
            // Current data has no _item field — the part name lives inside
            // Query as a quoted phrase, e.g.: 2001 DODGE Durango "center console lid"
            _item: item._item || (item.Query?.match(/"([^"]+)"/)?.[1] ?? "")
        }));

        createItemFilters();
        applyFilters();
    })
    .catch(err => console.error("Error loading JSON:", err));

// Part-interchange table (published from data/interchange.csv). Optional — if
// absent or empty, the scanner falls back to exact-year matching.
fetch("data/interchange.json")
    .then(res => res.ok ? res.json() : [])
    .then(data => { interchange = Array.isArray(data) ? data : []; })
    .catch(() => { interchange = []; });

/* =========================
   PART INTERCHANGE
========================= */
// Interchange range [lo, hi] for a given part on a vehicle/year, or null if no
// interchange data covers it. A part-specific row wins over the make/model
// default ("*").
function interchangeRange(make, model, part, year) {
    make = (make || "").toLowerCase();
    model = (model || "").toLowerCase();
    part = (part || "").toLowerCase();
    let fallback = null;
    for (const g of interchange) {
        if (g.make !== make || g.model !== model) continue;
        if (year < g.lo || year > g.hi) continue;
        if (g.part === part) return [g.lo, g.hi];          // part override wins
        if (g.part === "*" && !fallback) fallback = [g.lo, g.hi]; // generation default
    }
    return fallback;
}

// Does a row's year interchange with the scanned year for this part? With no
// interchange data, only the exact same year matches (today's behavior).
function interchanges(make, model, part, scanYear, rowYear) {
    const r = interchangeRange(make, model, part, scanYear);
    if (!r) return scanYear === rowYear;
    return rowYear >= r[0] && rowYear <= r[1];
}

/* =========================
   FILTERS
========================= */
function createItemFilters() {
    const container = document.getElementById("item-filters");
    container.innerHTML = "";

    const uniqueItems = [...new Set(allData.map(d => d._item).filter(Boolean))];

    uniqueItems.forEach(item => {
        const label = document.createElement("label");
        label.innerHTML = `<input type="checkbox" value="${escapeHtml(item)}"><span>${escapeHtml(item)}</span>`;

        const checkbox = label.querySelector("input");
        checkbox.addEventListener("change", () => {
            checkbox.checked ? selectedItems.add(item) : selectedItems.delete(item);
            label.classList.toggle("active", checkbox.checked);
            applyFilters();
        });

        container.appendChild(label);
    });
}

document.getElementById("clear-filters").addEventListener("click", () => {
    selectedItems.clear();
    document.querySelectorAll("#item-filters input").forEach(cb => {
        cb.checked = false;
        cb.parentElement.classList.remove("active");
    });
    document.getElementById("search").value = "";
    applyFilters();
});

/* =========================
   SEARCH + FILTER
========================= */
function applyFilters() {
    const words = document.getElementById("search").value.trim().toLowerCase().split(" ").filter(Boolean);

    filteredData = allData.filter(item => {
        const matchesSearch = words.every(word =>
            item.Make.toLowerCase().includes(word)  ||
            item.Model.toLowerCase().includes(word) ||
            String(item.Year).includes(word)         ||
            item._item.toLowerCase().includes(word)
        );
        const matchesItem = selectedItems.size === 0 || selectedItems.has(item._item);
        return matchesSearch && matchesItem;
    });

    applySort();
}

// Debounced — each keystroke would otherwise re-render every card
let searchDebounce;
document.getElementById("search").addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(applyFilters, 200);
});

/* =========================
   SORT
========================= */
function normalizeValue(val) {
    if (val === null || val === undefined) return 0;
    if (typeof val === "string") val = val.replace(/[$,]/g, "").trim();
    if (!isNaN(val) && val !== "") return Number(val);
    return String(val).toLowerCase();
}

function applySort() {
    let data = [...filteredData];

    if (currentSort.key) {
        data.sort((a, b) => {
            const valA = normalizeValue(a[currentSort.key]);
            const valB = normalizeValue(b[currentSort.key]);
            if (valA < valB) return currentSort.asc ? -1 : 1;
            if (valA > valB) return currentSort.asc ? 1 : -1;
            return 0;
        });
    }

    displayData(data);
}

const sortSelect = document.getElementById("sort-select");
sortSelect.addEventListener("change", e => {
    const key = e.target.value;
    if (!key) { currentSort = { key: null, asc: false }; applySort(); return; }
    if (currentSort.key === key) {
        currentSort.asc = !currentSort.asc;
    } else {
        currentSort.key = key;
        currentSort.asc = false;
    }
    applySort();
});

/* =========================
   DISPLAY CARDS
========================= */
function displayData(data) {
    const container = document.getElementById("cards-container");
    container.innerHTML = "";

    if (data.length === 0) {
        container.innerHTML = `<div class="empty-state">No results found.</div>`;
        return;
    }

    const fragment = document.createDocumentFragment();

    data.forEach(item => {
        const card = document.createElement("div");
        card.className = "data-card";

        const ebayURL = buildEbayURL(item);

        card.innerHTML = `
            <div class="card-top">
                <div class="card-info">
                    <div class="card-title">${escapeHtml(item._item)}</div>
                    <div class="card-sub">
                        ${escapeHtml(item.Year)} ${escapeHtml(item.Make)} ${escapeHtml(item.Model || "")}
                        &nbsp;·&nbsp;<span class="card-vin">${escapeHtml(item.VIN)}</span>
                    </div>
                </div>
                <div class="card-price">
                    <div class="price-main">$${escapeHtml(item["Average Price"])}</div>
                    <div class="price-label">avg</div>
                </div>
            </div>
            <div class="card-divider"></div>
            <div class="card-meta">
                <div>
                    <div class="meta-label">Median</div>
                    <div class="meta-val">$${escapeHtml(item["Median Price"])}</div>
                </div>
                <div>
                    <div class="meta-label">Sales</div>
                    <div class="meta-val">${escapeHtml(item["Number of Sales"])}</div>
                </div>
            </div>
            <div class="card-actions">
                <button class="btn-ghost details-btn">Details</button>
                <button class="btn-primary ebay-btn">eBay ↗</button>
            </div>
        `;

        card.querySelector(".details-btn").addEventListener("click", e => {
            e.stopPropagation();
            showDetails(item);
        });

        card.querySelector(".ebay-btn").addEventListener("click", e => {
            e.stopPropagation();
            window.open(ebayURL, "_blank");
        });

        card.addEventListener("click", () => showDetails(item));

        fragment.appendChild(card);
    });

    container.appendChild(fragment);
}

/* =========================
   DETAILS SHEET
========================= */
function showDetails(item) {
    document.getElementById("details").classList.remove("hidden");
    document.getElementById("d-vin").textContent    = item.VIN;
    document.getElementById("d-query").textContent  = item.Query;
    document.getElementById("d-year").textContent   = item.Year;
    document.getElementById("d-make").textContent   = item.Make;
    document.getElementById("d-model").textContent  = item.Model || "N/A";
    document.getElementById("d-avg").textContent    = `$${item["Average Price"]}`;
    document.getElementById("d-med").textContent    = `$${item["Median Price"]}`;
    document.getElementById("d-sales").textContent  = item["Number of Sales"];
}

function closeDetails() {
    document.getElementById("details").classList.add("hidden");
}

document.getElementById("close-details-btn").addEventListener("click", closeDetails);

/* =========================
   VIN SCANNER
========================= */
let scannerOpen = false;
let scanning = false;
let pendingStart = false; // camera startup in flight — lets Stop cancel it
let scanSession = 0;      // bumped on every start/stop; stale async startups abort
let detectorBound = false;
let lastVin = "";
let lastTime = 0;
let scannerMatches = [];
let scannerMatchSort = { key: null, asc: true };

const vinInput      = document.getElementById("vin-input");
const scannerStatus = document.getElementById("scanner-status");
const scannerError  = document.getElementById("scanner-error");
const scannerResult = document.getElementById("scanner-result");

function openScanner() {
    scannerOpen = true;
    document.getElementById("scanner-card").classList.remove("hidden");
    document.getElementById("scanner-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeScanner() {
    scannerOpen = false;
    document.getElementById("scanner-card").classList.add("hidden");
    stopScanner();
}

document.getElementById("toggle-scanner-btn").addEventListener("click", () => {
    scannerOpen ? closeScanner() : openScanner();
});

document.getElementById("scanner-close-btn").addEventListener("click", closeScanner);

document.getElementById("scanner-start-btn").addEventListener("click", startScanner);
document.getElementById("scanner-stop-btn").addEventListener("click", stopScanner);
document.getElementById("scanner-decode-btn").addEventListener("click", decodeVIN);

function startScanner() {
    if (scanning || pendingStart) return;
    scannerError.textContent = "";
    const session = ++scanSession;
    pendingStart = true;

    Quagga.init({
        inputStream: {
            name: "Live",
            type: "LiveStream",
            target: document.querySelector("#scanner-viewport"),
            constraints: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }
        },
        locator: { patchSize: "medium", halfSample: false },
        decoder: { readers: ["code_39_reader", "code_128_reader"] },
        locate: false
    }, function (err) {
        pendingStart = false;
        if (err) {
            console.error(err);
            scannerError.textContent = "Failed to access camera.";
            return;
        }
        // User hit Stop (or closed the scanner) while the camera was starting
        if (session !== scanSession) {
            try { Quagga.stop(); } catch (e) {}
            return;
        }
        if (!detectorBound) {
            Quagga.onDetected(onDetected);
            detectorBound = true;
        }
        Quagga.start();
        scanning = true;
    });
}

function stopScanner() {
    if (!scanning && !pendingStart) return;
    scanSession++;   // any in-flight camera startup sees a stale session and aborts
    pendingStart = false;
    if (scanning) {
        Quagga.offDetected(onDetected);
        try { Quagga.stop(); } catch (e) {}
        detectorBound = false;
    }
    const video = document.querySelector("#scanner-viewport video");
    if (video && video.srcObject) {
        video.srcObject.getTracks().forEach(t => t.stop());
        video.srcObject = null;
    }
    scanning = false;
}

function onDetected(result) {
    const cleaned = result.codeResult.code.replace(/[^A-Z0-9]/gi, "").toUpperCase();
    const vinMatch = cleaned.match(/[A-HJ-NPR-Z0-9]{17}/);
    if (!vinMatch) {
        scannerStatus.textContent = `Scanned: ${cleaned}`;
        return;
    }
    const vin = vinMatch[0];
    const now = Date.now();
    if (vin === lastVin && now - lastTime < 1000) return;
    lastVin = vin;
    lastTime = now;
    scannerStatus.textContent = "Detected: " + vin;
    vinInput.value = vin;
    stopScanner();
    decodeVIN();
}

async function decodeVIN() {
    const vin = vinInput.value.trim().toUpperCase();
    scannerResult.innerHTML = "";
    scannerError.textContent = "";

    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
        scannerError.textContent = "Invalid VIN. Must be 17 characters, no I, O, or Q.";
        return;
    }

    scannerResult.innerHTML = "<p style='color:var(--text-muted);font-size:13px;'>Loading…</p>";

    try {
        const response = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/decodevin/${vin}?format=json`);
        if (!response.ok) throw new Error("Network response failed");
        const data = await response.json();
        const results = data.Results;

        function get(label) {
            const item = results.find(r => r.Variable === label);
            return (!item || item.Value === null || item.Value === "" || item.Value === "Not Applicable") ? "N/A" : item.Value;
        }

        const year  = get("Model Year");
        const make  = get("Make");
        const model = get("Model");

        const sections = [
            { heading: "Vehicle", fields: [
                ["Year", year], ["Make", make], ["Model", model],
                ["Trim", get("Trim")], ["Body Class", get("Body Class")], ["Vehicle Type", get("Vehicle Type")]
            ]},
            { heading: "Engine / Drivetrain", fields: [
                ["Displacement", get("Displacement (L)") !== "N/A" ? get("Displacement (L)") + "L" : "N/A"],
                ["Cylinders", get("Engine Number of Cylinders")],
                ["Horsepower", get("Engine Brake (hp) From") !== "N/A" ? get("Engine Brake (hp) From") + " hp" : "N/A"],
                ["Fuel Type", get("Fuel Type - Primary")],
                ["Drive Type", get("Drive Type")],
                ["Transmission", get("Transmission Style")]
            ]},
            { heading: "Safety", fields: [
                ["ABS", get("Anti-lock Braking System (ABS)")],
                ["ESC", get("Electronic Stability Control (ESC)")],
                ["Backup Camera", get("Backup Camera")],
                ["TPMS", get("Tire Pressure Monitoring System (TPMS) Type")]
            ]}
        ];

        let html = `<h3>NHTSA — ${escapeHtml(vin)}</h3>`;
        for (const section of sections) {
            html += `<h3>${section.heading}</h3><div class="vehicle-info-grid">`;
            for (const [label, value] of section.fields) {
                html += `<div class="vehicle-info-card">
                    <div class="label">${escapeHtml(label)}</div>
                    <div class="value">${escapeHtml(value)}</div>
                </div>`;
            }
            html += `</div>`;
        }

        const scanYear = parseInt(year, 10);
        scannedCtx = { make, model, year: scanYear };
        // Same make/model, and a year that interchanges with the scanned year
        // for that specific part (falls back to exact year when no data).
        scannerMatches = allData.filter(item =>
            item.Make.toLowerCase()  === make.toLowerCase()  &&
            item.Model.toLowerCase() === model.toLowerCase() &&
            interchanges(make, model, item._item, scanYear, parseInt(item.Year, 10))
        );
        scannerMatchSort = { key: null, asc: true };

        html += `<div id="scanner-matches-section"></div>`;
        scannerResult.innerHTML = html;
        renderMatchesTable();

    } catch (err) {
        console.error(err);
        scannerError.textContent = "Failed to fetch VIN data from NHTSA.";
        scannerResult.innerHTML = "";
    }
}

function renderMatchesTable() {
    const section = document.getElementById("scanner-matches-section");
    if (!section) return;

    const sorted = [...scannerMatches].sort((a, b) => {
        if (!scannerMatchSort.key) return 0;
        const valA = normalizeValue(a[scannerMatchSort.key]);
        const valB = normalizeValue(b[scannerMatchSort.key]);
        if (valA < valB) return scannerMatchSort.asc ? -1 : 1;
        if (valA > valB) return scannerMatchSort.asc ? 1 : -1;
        return 0;
    });

    const columns = [
        { label: "Item",      key: "_item" },
        { label: "Year",      key: "Year" },
        { label: "Avg Price", key: "Average Price" },
        { label: "Median",    key: "Median Price" },
        { label: "Sales",     key: "Number of Sales" },
    ];

    let html = `<h3>Matching Inventory (${scannerMatches.length})</h3>`;

    if (scannerMatches.length === 0) {
        html += `<p class="no-matches">No entries in inventory match this vehicle.</p>`;
        section.innerHTML = html;
        return;
    }

    // If interchange pulled in years other than the one scanned, say so.
    const years = scannerMatches.map(m => parseInt(m.Year, 10)).filter(y => !isNaN(y));
    const yLo = Math.min(...years), yHi = Math.max(...years);
    if (years.length && (yLo !== yHi || yLo !== scannedCtx.year)) {
        html += `<p class="no-matches" style="color:var(--text-muted);">Including interchange years ${yLo}–${yHi} (scanned ${scannedCtx.year}).</p>`;
    }

    html += `<table class="scanner-matches-table"><thead><tr>`;
    for (const col of columns) {
        const active = scannerMatchSort.key === col.key;
        const arrow = active ? (scannerMatchSort.asc ? " ▲" : " ▼") : "";
        html += `<th data-sort-key="${col.key}" class="sortable">${col.label}${arrow}</th>`;
    }
    html += `<th>eBay</th></tr></thead><tbody>`;

    for (const item of sorted) {
        const ebayURL = escapeHtml(buildInterchangeEbayURL(item));
        html += `<tr>
            <td>${escapeHtml(item._item)}</td>
            <td>${escapeHtml(String(item.Year))}</td>
            <td>$${escapeHtml(String(item["Average Price"]))}</td>
            <td>$${escapeHtml(String(item["Median Price"]))}</td>
            <td>${escapeHtml(String(item["Number of Sales"]))}</td>
            <td><a href="${ebayURL}" target="_blank" class="btn-primary" style="text-decoration:none;display:inline-block;padding:4px 10px;font-size:12px;border-radius:6px;">eBay ↗</a></td>
        </tr>`;
    }
    html += `</tbody></table>`;
    section.innerHTML = html;

    section.querySelectorAll("th[data-sort-key]").forEach(th => {
        th.addEventListener("click", () => {
            const key = th.getAttribute("data-sort-key");
            if (scannerMatchSort.key === key) {
                scannerMatchSort.asc = !scannerMatchSort.asc;
            } else {
                scannerMatchSort.key = key;
                scannerMatchSort.asc = true;
            }
            renderMatchesTable();
        });
    });
}

// Escapes quotes too, so output is safe in attribute values
function escapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
}

// eBay sold-listings search URL; falls back to year/make/model/item when Query is missing
function buildEbayURL(item) {
    const queryText = item.Query || `${item.Year || ""} ${item.Make} ${item.Model || ""} ${item._item}`.trim();
    return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(queryText)}&LH_Sold=1&LH_Complete=1&LH_ItemCondition=4`;
}

// Like buildEbayURL, but when an interchange range is known for the scanned
// vehicle+part, search the whole range (e.g. "1998-2002 toyota corolla
// headlight") for a wider, more accurate set of sold comps.
function buildInterchangeEbayURL(item) {
    const r = interchangeRange(scannedCtx.make, scannedCtx.model, item._item, scannedCtx.year);
    if (r && r[0] !== r[1]) {
        const q = `${r[0]}-${r[1]} ${scannedCtx.make} ${scannedCtx.model} ${item._item}`.trim();
        return `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&LH_Sold=1&LH_Complete=1&LH_ItemCondition=4`;
    }
    return buildEbayURL(item);
}

/* =========================
   PWA INSTALL
========================= */
let deferredPrompt;

window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault();
    deferredPrompt = e;

    const btn = document.createElement("button");
    btn.textContent = "Install App";
    btn.className = "scan-btn";
    Object.assign(btn.style, {
        position: "fixed",
        bottom: "20px",
        right: "20px",
        zIndex: "1000"
    });

    document.body.appendChild(btn);
    btn.addEventListener("click", async () => {
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
        btn.remove();
    });
});

/* =========================
   SERVICE WORKER
========================= */
if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker
            .register("./service-worker.js")
            .catch(err => console.error(err));
    });
}
