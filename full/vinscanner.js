// ================================================
// STATE
// ================================================
let scanning      = false;
let scanMode      = null; // "barcode" | "ocr"
let pendingStart  = false; // camera startup in flight — lets Stop cancel it
let scanSession   = 0;     // bumped on every start/stop; stale async startups abort
let detectorBound = false;
let lastVin       = "";
let lastTime      = 0;

// Torch
let torchOn = false;

// OCR
let ocrWorker        = null;
let ocrInterval      = null;
let ocrBusy          = false;
let mediaStream      = null; // getUserMedia stream for OCR mode
let lastOcrCandidate = "";   // checksum-invalid match awaiting 2nd-frame confirmation

// Current decode — persisted for PDF export
let currentVin            = "";
let currentMake           = "";
let currentModel          = "";
let currentYear           = "";
let currentImageUrl       = null;
let currentDecodedSections = [];
let currentRecalls        = null; // null = not yet fetched

const vinInput      = document.getElementById("vinInput");
const resultDiv     = document.getElementById("result");
const errorDiv      = document.getElementById("error");
const barcodeResult = document.getElementById("barcode-result");
const vinCounter    = document.getElementById("vin-counter");

// ================================================
// THEME — shares the "theme" key with the VIN Viewer
// (default light when unset, matching the viewer)
// ================================================
function applyTheme(light) {
    document.body.classList.toggle("light", light);
    localStorage.setItem("theme", light ? "light" : "dark");
}

applyTheme(localStorage.getItem("theme") !== "dark");

document.getElementById("themeBtn").addEventListener("click", () => {
    applyTheme(!document.body.classList.contains("light"));
});

// ================================================
// VIN COUNTER
// ================================================
vinInput.addEventListener("input", () => {
    const len = vinInput.value.length;
    vinCounter.textContent = `${len} / 17`;
    vinCounter.className = "vin-counter" + (len === 17 ? " valid" : len > 0 ? " partial" : "");
    vinInput.className   = "vin-input"   + (len === 17 ? " ready" : "");
});

// ================================================
// HISTORY
// ================================================
const HISTORY_KEY = "vin-scan-history";
const MAX_HISTORY = 50;

function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); }
    catch { return []; }
}

function saveToHistory(entry) {
    const list = loadHistory().filter(h => h.vin !== entry.vin);
    list.unshift(entry);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, MAX_HISTORY)));
}

function formatAge(ts) {
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins < 1)  return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)  return `${hrs}h ago`;
    return new Date(ts).toLocaleDateString();
}

function renderHistory() {
    const list   = loadHistory();
    const listEl = document.getElementById("history-list");
    if (list.length === 0) {
        listEl.innerHTML = `<p class="history-empty">No scans yet.</p>`;
        return;
    }
    listEl.innerHTML = list.map(entry => `
        <div class="history-item" data-vin="${escapeHtml(entry.vin)}">
            <div class="history-item-main">
                <span class="history-vehicle">${escapeHtml(entry.year)} ${escapeHtml(entry.make)} ${escapeHtml(entry.model)}</span>
                <span class="history-time">${formatAge(entry.timestamp)}</span>
            </div>
            <span class="history-vin">${escapeHtml(entry.vin)}</span>
        </div>
    `).join("");
    listEl.querySelectorAll(".history-item").forEach(el => {
        el.addEventListener("click", () => {
            vinInput.value = el.getAttribute("data-vin");
            vinInput.dispatchEvent(new Event("input"));
            document.getElementById("history-panel").classList.add("hidden");
            decodeVIN();
        });
    });
}

document.getElementById("historyBtn").addEventListener("click", () => {
    const panel   = document.getElementById("history-panel");
    const opening = panel.classList.contains("hidden");
    panel.classList.toggle("hidden", !opening);
    if (opening) renderHistory();
});

document.getElementById("clearHistoryBtn").addEventListener("click", () => {
    localStorage.removeItem(HISTORY_KEY);
    renderHistory();
});

// ================================================
// VIN CHECK DIGIT (ISO 3779, position 9)
// ================================================
const VIN_CHAR_VALUES = {
    A:1, B:2, C:3, D:4, E:5, F:6, G:7, H:8,
    J:1, K:2, L:3, M:4, N:5, P:7, R:9,
    S:2, T:3, U:4, V:5, W:6, X:7, Y:8, Z:9
};
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

function vinCheckDigitValid(vin) {
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return false;
    let sum = 0;
    for (let i = 0; i < 17; i++) {
        const c = vin[i];
        const v = c >= "0" && c <= "9" ? Number(c) : VIN_CHAR_VALUES[c];
        sum += v * VIN_WEIGHTS[i];
    }
    const rem = sum % 11;
    return vin[8] === (rem === 10 ? "X" : String(rem));
}

// OCR misreads: characters Tesseract commonly confuses. I/O/Q are invalid in
// VINs so they're always mapped; the rest are tried one position at a time
// against the check digit.
const OCR_SWAPS = { S:"5", "5":"S", B:"8", "8":"B", Z:"2", "2":"Z", G:"6", "6":"G", D:"0", "0":"D" };

// Find a checksum-valid VIN in raw OCR text, trying misread corrections.
// I/O/Q never appear in real VINs, so mapping them (I→1, O→0, Q→0) is always
// safe. Every overlapping 17-char window is checked unmodified BEFORE any
// swap correction — a swapped wrong window can pass the checksum by chance
// (1-in-11) and must never shadow a literal valid VIN elsewhere in the text.
// Only a literal checksum pass is "certain"; swap-corrected and checksum-less
// results require the same read on two consecutive frames (caller enforces).
// ISO 3779 requires the last 4 characters to be numeric — used to filter junk.
function findValidVinInText(raw) {
    const cleaned = raw.replace(/[^A-Z0-9]/gi, "").toUpperCase();
    const mapped  = cleaned.replace(/I/g, "1").replace(/[OQ]/g, "0");

    const windows   = []; // swap-correction sources (misread may sit in the last 4)
    const plausible = []; // structurally valid: charset ok and ends in 4 digits
    for (let i = 0; i + 17 <= mapped.length; i++) {
        const win = mapped.slice(i, i + 17);
        if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(win)) continue;
        if (/\d{4}$/.test(win)) {
            if (vinCheckDigitValid(win)) return { vin: win, certain: true };
            plausible.push(win);
        }
        windows.push(win);
    }

    // Single-character misread corrections, only if no literal window validated
    for (const win of windows) {
        for (let p = 0; p < 17; p++) {
            const alt = OCR_SWAPS[win[p]];
            if (!alt) continue;
            const cand = win.slice(0, p) + alt + win.slice(p + 1);
            if (/\d{4}$/.test(cand) && vinCheckDigitValid(cand)) {
                return { vin: cand, certain: false };
            }
        }
    }

    // Checksum-invalid but structurally plausible (some non-NA VINs skip the
    // check digit)
    if (plausible.length) return { vin: plausible[0], certain: false };

    return null;
}

// ================================================
// TORCH / FLASHLIGHT
// ================================================
const torchBtn = document.getElementById("torchBtn");

function getActiveVideoTrack() {
    if (mediaStream) return mediaStream.getVideoTracks()[0] || null;
    const video = document.querySelector("#interactive video");
    return video?.srcObject?.getVideoTracks?.()[0] || null;
}

function updateTorchButton() {
    const track = getActiveVideoTrack();
    const supported = !!track?.getCapabilities?.().torch;
    torchOn = false;
    torchBtn.textContent = "🔦";
    torchBtn.classList.toggle("hidden", !supported);
}

function hideTorchButton() {
    torchOn = false;
    torchBtn.textContent = "🔦";
    torchBtn.classList.add("hidden");
}

torchBtn.addEventListener("click", async () => {
    const track = getActiveVideoTrack();
    if (!track) return;
    try {
        await track.applyConstraints({ advanced: [{ torch: !torchOn }] });
        torchOn = !torchOn;
        torchBtn.textContent = torchOn ? "🔦 On" : "🔦";
    } catch (e) {
        console.error("Torch toggle failed:", e);
    }
});

// ================================================
// SHARED VIN HANDLER
// ================================================
function onVinFound(vin, source) {
    const now = Date.now();
    if (vin === lastVin && now - lastTime < 1500) return;
    lastVin  = vin;
    lastTime = now;
    if (navigator.vibrate) navigator.vibrate(200);
    barcodeResult.textContent = `${source}: ${vin}`;
    vinInput.value = vin;
    vinInput.dispatchEvent(new Event("input"));
    stopScanner();
    decodeVIN();
}

// ================================================
// BARCODE SCANNER (Quagga2)
// ================================================
document.getElementById("startBtn").addEventListener("click", () => startScanner("barcode"));
document.getElementById("ocrBtn").addEventListener("click", () => startScanner("ocr"));
document.getElementById("stopBtn").addEventListener("click", stopScanner);
document.getElementById("decodeBtn").addEventListener("click", decodeVIN);
document.getElementById("refreshBtn").addEventListener("click", hardRefresh);

function startScanner(mode = "barcode") {
    if (scanning || pendingStart) return;
    scanMode = mode;
    errorDiv.textContent = "";
    clearViewport();
    if (mode === "barcode") startBarcodeMode();
    else                    startOcrMode();
}

// ---- Barcode mode (Quagga2) ----
function startBarcodeMode() {
    barcodeResult.textContent = "Starting camera…";
    const session = ++scanSession;
    pendingStart  = true;

    Quagga.init({
        inputStream: {
            name: "Live", type: "LiveStream",
            target: document.querySelector("#interactive"),
            constraints: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }
        },
        locator:  { patchSize: "medium", halfSample: false },
        decoder:  { readers: ["code_39_reader", "code_128_reader"] },
        locate:   false
    }, function(err) {
        pendingStart = false;
        if (err) {
            console.error(err);
            errorDiv.textContent = "Failed to access camera.";
            barcodeResult.textContent = "No barcode detected";
            scanMode = null;
            return;
        }
        // User hit Stop while the camera was starting — release it and bail
        if (session !== scanSession) {
            try { Quagga.stop(); } catch (e) {}
            clearViewport();
            return;
        }
        if (!detectorBound) {
            Quagga.onDetected(onBarcodeDetected);
            detectorBound = true;
        }
        Quagga.start();
        scanning = true;
        barcodeResult.textContent = "Scanning for barcode…";
        updateTorchButton();
    });
}

// ---- OCR mode (getUserMedia + Tesseract) ----
async function startOcrMode() {
    barcodeResult.textContent = "Starting camera…";
    const session = ++scanSession;
    pendingStart  = true;
    let stream    = null;
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        if (session !== scanSession) { // stopped during startup
            stream.getTracks().forEach(t => t.stop());
            pendingStart = false;
            return;
        }
        mediaStream = stream;

        const viewport = document.querySelector("#interactive");
        const video = document.createElement("video");
        video.setAttribute("playsinline", "");
        video.muted = true;
        viewport.insertBefore(video, viewport.firstChild);
        video.srcObject = mediaStream;
        await video.play();

        if (session !== scanSession) { pendingStart = false; return; }

        pendingStart     = false;
        scanning         = true;
        lastOcrCandidate = "";
        barcodeResult.textContent = "Scanning for VIN from text…";
        updateTorchButton();

        const worker = await Tesseract.createWorker("eng");
        if (!scanning || session !== scanSession) { worker.terminate(); return; }
        ocrWorker   = worker;
        ocrInterval = setInterval(runOcrFrame, 2000);
    } catch (e) {
        console.error("OCR mode failed:", e);
        pendingStart = false;
        errorDiv.textContent = "Failed to access camera.";
        barcodeResult.textContent = "No barcode detected";
        scanMode = null;
        if (stream) stream.getTracks().forEach(t => t.stop());
        if (mediaStream === stream) mediaStream = null;
    }
}

// Remove any leftover video/canvas from the viewport (keeps .scan-box)
function clearViewport() {
    document.querySelectorAll("#interactive video, #interactive canvas").forEach(el => el.remove());
}

function stopScanner() {
    if (!scanning && !pendingStart) return;
    const wasMode = scanMode;
    scanSession++;        // any in-flight camera startup sees a stale session and aborts
    pendingStart = false;
    scanning = false;
    hideTorchButton();

    // Tear down OCR (if running)
    clearInterval(ocrInterval);
    ocrInterval = null;
    if (ocrWorker) {
        ocrWorker.terminate().catch(() => {});
        ocrWorker = null;
    }
    ocrBusy = false;

    // Tear down barcode pipeline (if running)
    if (wasMode === "barcode") {
        Quagga.offDetected(onBarcodeDetected);
        try { Quagga.stop(); } catch (e) {}
        detectorBound = false;
    }

    // Stop the OCR camera stream
    if (mediaStream) {
        mediaStream.getTracks().forEach(t => t.stop());
        mediaStream = null;
    }

    // Stop any remaining stream attached to a video element
    const video = document.querySelector("#interactive video");
    if (video?.srcObject) {
        video.srcObject.getTracks().forEach(t => t.stop());
        video.srcObject = null;
    }

    clearViewport();
    scanMode = null;
}

function onBarcodeDetected(result) {
    const cleaned  = result.codeResult.code.replace(/[^A-Z0-9]/gi, "").toUpperCase();
    const vinMatch = cleaned.match(/[A-HJ-NPR-Z0-9]{17}/);
    if (!vinMatch) { barcodeResult.textContent = `Scanned: ${cleaned}`; return; }
    // Barcode reads are reliable — accept even if the check digit fails
    // (decodeVIN surfaces a warning); checksum failures on non-NA VINs are normal.
    onVinFound(vinMatch[0], "Barcode");
}

// ================================================
// OCR — live frame analysis every 2s
// ================================================
async function runOcrFrame() {
    if (ocrBusy || !ocrWorker || !scanning) return;
    const video = document.querySelector("#interactive video");
    if (!video || !video.videoWidth || !video.videoHeight) return;

    ocrBusy = true;
    try {
        const vw = video.videoWidth, vh = video.videoHeight;
        const canvas = document.createElement("canvas");
        canvas.width  = vw;
        canvas.height = Math.floor(vh * 0.30);
        canvas.getContext("2d").drawImage(
            video, 0, Math.floor(vh * 0.35), vw, canvas.height, 0, 0, vw, canvas.height
        );
        const { data: { text } } = await ocrWorker.recognize(canvas);
        if (!scanning) { ocrBusy = false; return; }
        const found = findValidVinInText(text);
        if (found) {
            if (found.certain) {
                onVinFound(found.vin, "OCR");
            } else if (found.vin === lastOcrCandidate) {
                // Checksum-invalid but read identically on two consecutive
                // frames — likely a real (non-North-American) VIN
                onVinFound(found.vin, "OCR");
            } else {
                lastOcrCandidate = found.vin;
                barcodeResult.textContent = `Possible VIN: ${found.vin} — confirming…`;
            }
        }
    } catch(e) { console.error("OCR frame error:", e); }
    ocrBusy = false;
}

// ================================================
// DECODE VIN
// ================================================
async function decodeVIN() {
    const vin = vinInput.value.trim().toUpperCase();
    resultDiv.innerHTML = "";
    errorDiv.textContent = "";

    if (vin.length !== 17) {
        errorDiv.textContent = `VIN must be exactly 17 characters (you have ${vin.length}).`;
        return;
    }
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
        errorDiv.textContent = "Invalid VIN — cannot contain I, O, or Q.";
        return;
    }

    // Warn but proceed — non-North-American VINs don't always use the check digit
    const checkDigitOk = vinCheckDigitValid(vin);

    resultDiv.innerHTML = `<p class="loading">Decoding VIN…</p>`;

    try {
        const res = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/decodevin/${vin}?format=json`);
        if (!res.ok) throw new Error("NHTSA request failed");
        const results = (await res.json()).Results;

        function get(label) {
            const item = results.find(r => r.Variable === label);
            return (!item || !item.Value || item.Value === "Not Applicable") ? "N/A" : item.Value;
        }

        // Store globally for PDF export
        currentVin     = vin;
        currentYear    = get("Model Year");
        currentMake    = get("Make");
        currentModel   = get("Model");
        currentRecalls = null; // reset — new vehicle, recalls not yet fetched

        if (currentYear !== "N/A" && currentMake !== "N/A") {
            saveToHistory({ vin, year: currentYear, make: currentMake, model: currentModel, timestamp: Date.now() });
        }

        const sections = [
            { heading: "Vehicle", fields: [
                ["Year",         get("Model Year")],
                ["Make",         get("Make")],
                ["Model",        get("Model")],
                ["Trim",         get("Trim")],
                ["Series",       get("Series")],
                ["Body Class",   get("Body Class")],
                ["Vehicle Type", get("Vehicle Type")],
                ["Doors",        get("Doors")],
                ["Seats",        get("Number of Seats")],
            ]},
            { heading: "Engine / Drivetrain", fields: [
                ["Engine",        get("Engine Model")],
                ["Displacement",  get("Displacement (L)") !== "N/A" ? get("Displacement (L)") + "L" : "N/A"],
                ["Cylinders",     get("Engine Number of Cylinders")],
                ["Horsepower",    get("Engine Brake (hp) From") !== "N/A" ? get("Engine Brake (hp) From") + " hp" : "N/A"],
                ["Fuel Type",     get("Fuel Type - Primary")],
                ["Drive Type",    get("Drive Type")],
                ["Transmission",  get("Transmission Style")],
                ["Trans. Speeds", get("Transmission Speeds")],
            ]},
            { heading: "Chassis", fields: [
                ["Wheelbase",        get("Wheel Base (inches) From") !== "N/A" ? get("Wheel Base (inches) From") + " in" : "N/A"],
                ["Wheel Size Front", get("Wheel Size Front (inches)") !== "N/A" ? get("Wheel Size Front (inches)") + " in" : "N/A"],
                ["Wheel Size Rear",  get("Wheel Size Rear (inches)") !== "N/A" ? get("Wheel Size Rear (inches)") + " in" : "N/A"],
                ["GVWR",             get("Gross Vehicle Weight Rating From")],
            ]},
            { heading: "Safety", fields: [
                ["ABS",           get("Anti-lock Braking System (ABS)")],
                ["ESC",           get("Electronic Stability Control (ESC)")],
                ["Backup Camera", get("Backup Camera")],
                ["TPMS",          get("Tire Pressure Monitoring System (TPMS) Type")],
            ]},
            { heading: "Manufacturing", fields: [
                ["Manufacturer",  get("Manufacturer Name")],
                ["Plant City",    get("Plant City")],
                ["Plant State",   get("Plant State")],
                ["Plant Country", get("Plant Country")],
            ]},
        ];

        currentDecodedSections = sections; // store for PDF

        const imagePromise = fetchVehicleImage(currentMake, currentModel, currentYear);

        const partsSearch = `${currentYear} ${currentMake} ${currentModel}`
            .split(" ").filter(p => p && p !== "N/A").join(" ");

        let html = `
            ${checkDigitOk ? "" : `<div class="checksum-warning">⚠ VIN check digit doesn't validate — double-check for misread characters.</div>`}
            <div class="result-header">
                <div id="vehicle-image-wrap" class="vehicle-image-wrap">
                    <div class="image-placeholder">Loading image…</div>
                </div>
                <div class="result-hero">
                    <div class="result-year-make">${escapeHtml(currentYear)} ${escapeHtml(currentMake)} ${escapeHtml(currentModel)}</div>
                    <div class="result-vin">${escapeHtml(vin)}</div>
                    <div class="result-actions">
                        <button id="copyVinBtn" class="action-btn">Copy VIN</button>
                        <button id="shareBtn" class="action-btn hidden">Share</button>
                        <a id="partsLink" class="action-btn" href="../index.html?search=${encodeURIComponent(partsSearch)}">Find Part Prices</a>
                    </div>
                </div>
                <button id="recallBtn" class="recall-btn">⚠ Check Recalls (model year)</button>
            </div>
            <div id="recall-section" class="recall-section hidden"></div>
        `;

        for (const section of sections) {
            const hasData = section.fields.some(([, v]) => v !== "N/A");
            if (!hasData) continue;
            html += `<div class="result-section-heading">${section.heading}</div><div class="info-grid">`;
            for (const [label, value] of section.fields) {
                if (value === "N/A") continue;
                html += `<div class="info-card">
                    <div class="info-label">${escapeHtml(label)}</div>
                    <div class="info-value">${escapeHtml(value)}</div>
                </div>`;
            }
            html += `</div>`;
        }

        html += `<button id="export-btn" class="export-btn">Export PDF</button>`;

        resultDiv.innerHTML = html;

        // Recall button: fetch on first click, toggle visibility after that
        document.getElementById("recallBtn").addEventListener("click", () => {
            if (currentRecalls === null) {
                checkRecalls(currentMake, currentModel, currentYear);
            } else {
                document.getElementById("recall-section").classList.toggle("hidden");
            }
        });
        document.getElementById("export-btn").addEventListener("click", exportPDF);

        // Copy VIN
        const copyBtn = document.getElementById("copyVinBtn");
        copyBtn.addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText(vin);
                copyBtn.textContent = "Copied!";
                setTimeout(() => { copyBtn.textContent = "Copy VIN"; }, 1500);
            } catch (e) {
                console.error("Clipboard failed:", e);
            }
        });

        // Web Share (mobile) — hidden where unsupported
        const shareBtn = document.getElementById("shareBtn");
        if (navigator.share) {
            shareBtn.classList.remove("hidden");
            shareBtn.addEventListener("click", () => {
                navigator.share({
                    title: `${currentYear} ${currentMake} ${currentModel}`,
                    text: `${currentYear} ${currentMake} ${currentModel} — VIN: ${vin}`
                }).catch(() => {});
            });
        }

        // Resolve image
        currentImageUrl     = null;
        const imageData     = await imagePromise;
        const imageWrap     = document.getElementById("vehicle-image-wrap");
        if (imageData) {
            currentImageUrl = imageData.url;
            imageWrap.innerHTML = `
                <a href="${imageData.pageUrl}" target="_blank" rel="noopener" class="image-link">
                    <img src="${imageData.url}" alt="${escapeHtml(currentYear)} ${escapeHtml(currentMake)} ${escapeHtml(currentModel)}" class="vehicle-image" />
                    <span class="image-credit">Image via Wikipedia</span>
                </a>`;
        } else {
            imageWrap.innerHTML = `<div class="image-unavailable">No image available</div>`;
        }

    } catch(err) {
        console.error(err);
        errorDiv.textContent = "Failed to fetch VIN data from NHTSA.";
        resultDiv.innerHTML = "";
    }
}

// ================================================
// VEHICLE IMAGE
// Strategy:
//   1. Parse the model's Wikipedia article — find the generation
//      section whose year range contains the target year, return its image.
//   2. Fall back to year-filtered Wikipedia search.
// ================================================
function titleCase(str) {
    return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

async function fetchVehicleImage(make, model, year) {
    const byGen = await fetchImageByGeneration(make, model, year);
    if (byGen) return byGen;
    return await fetchImageBySearch(make, model, year);
}

// ---- Generation-aware lookup ----------------------------------------
async function fetchImageByGeneration(make, model, year) {
    try {
        const yearInt = parseInt(year, 10);
        if (!yearInt) return null;
        const makeTC  = titleCase(make);
        const modelTC = titleCase(model);

        const pageTitle = await findCarArticle(makeTC, modelTC);
        if (!pageTitle) return null;

        const params = new URLSearchParams({
            action: "parse", page: pageTitle, prop: "sections|wikitext",
            format: "json", origin: "*", redirects: "1"
        });
        const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`);
        if (!res.ok) return null;
        const data = await res.json();
        const wikitext = data.parse?.wikitext?.["*"];
        const sections = data.parse?.sections;
        if (!wikitext || !sections) return null;

        const target = findGenerationSection(sections, yearInt);
        if (!target) return null;

        const body = extractSectionBody(wikitext, sections, target);
        const file = findImageInSection(body);
        if (!file) return null;

        const url = await resolveFileThumb(file);
        if (!url) return null;

        const resolvedTitle = data.parse.title || pageTitle;
        return {
            url,
            pageUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(resolvedTitle.replace(/ /g, "_"))}`
        };
    } catch(e) {
        console.error("Generation image lookup failed:", e);
        return null;
    }
}

async function findCarArticle(make, model) {
    // Try direct page first
    try {
        const params = new URLSearchParams({
            action: "query", titles: `${make} ${model}`,
            redirects: "1", format: "json", origin: "*"
        });
        const res  = await fetch(`https://en.wikipedia.org/w/api.php?${params}`);
        const data = await res.json();
        const page = Object.values(data.query?.pages || {})[0];
        if (page && !page.missing && page.pageid > 0) return page.title;
    } catch(e) {}

    // Fall back to search
    try {
        const params = new URLSearchParams({
            action: "query", list: "search",
            srsearch: `${make} ${model}`, srlimit: "1",
            format: "json", origin: "*"
        });
        const res  = await fetch(`https://en.wikipedia.org/w/api.php?${params}`);
        const data = await res.json();
        return data.query?.search?.[0]?.title || null;
    } catch(e) { return null; }
}

function parseYearRange(text) {
    // "1972–1979", "1972-1979", "1996–present", "(2016 to present)"
    const m = text.match(/(\d{4})\s*(?:[–\-—−]|to)\s*(\d{4}|present|current|now)/i);
    if (!m) return null;
    const start = parseInt(m[1], 10);
    const end   = /present|current|now/i.test(m[2]) ? new Date().getFullYear() + 1 : parseInt(m[2], 10);
    return [start, end];
}

function findGenerationSection(sections, yearInt) {
    const candidates = [];
    for (const sec of sections) {
        if (sec.fromtitle && sec.fromtitle !== sections[0]?.fromtitle) continue; // skip transcluded
        const line  = (sec.line || "").replace(/<[^>]+>/g, ""); // strip HTML tags
        const range = parseYearRange(line);
        if (!range) continue;
        const [start, end] = range;
        if (yearInt < start || yearInt > end) continue;
        const isGen = /generation|series|mark\b|mk[\s.]?\d|facelift/i.test(line);
        candidates.push({ sec, isGen, span: end - start });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
        if (a.isGen !== b.isGen) return a.isGen ? -1 : 1; // prefer generation/mark
        return a.span - b.span;                            // then narrower range
    });
    return candidates[0].sec;
}

function extractSectionBody(wikitext, sections, target) {
    const start = target.byteoffset;
    if (start == null) return "";
    const idx   = sections.indexOf(target);
    const level = parseInt(target.toclevel, 10);
    let end = wikitext.length;
    // End where the next same-or-higher-level section begins
    for (let i = idx + 1; i < sections.length; i++) {
        const lvl = parseInt(sections[i].toclevel, 10);
        if (lvl <= level && sections[i].byteoffset != null) {
            end = sections[i].byteoffset;
            break;
        }
    }
    return wikitext.slice(start, end);
}

function isPhotoFile(name) {
    if (!name) return false;
    if (/\.svg$/i.test(name)) return false;
    if (/\b(logo|icon|diagram|emblem|map|chart|graph|badge)\b/i.test(name)) return false;
    return /\.(jpe?g|png|webp|tiff?)$/i.test(name);
}

function findImageInSection(sectionText) {
    // 1. Prefer infobox `| image = filename.jpg`
    const ibox = sectionText.match(/\|\s*image\s*=\s*([^\n|<]+)/i);
    if (ibox) {
        const name = ibox[1].trim().replace(/^File:/i, "").replace(/\]\]$/, "");
        if (isPhotoFile(name)) return name;
    }
    // 2. First photo-like [[File:...]] inline
    const matches = sectionText.matchAll(/\[\[File:([^|\]\n]+)/gi);
    for (const m of matches) {
        const name = m[1].trim();
        if (isPhotoFile(name)) return name;
    }
    return null;
}

async function resolveFileThumb(fileName) {
    try {
        const params = new URLSearchParams({
            action: "query", titles: `File:${fileName}`,
            prop: "imageinfo", iiprop: "url", iiurlwidth: "640",
            format: "json", origin: "*"
        });
        const res  = await fetch(`https://en.wikipedia.org/w/api.php?${params}`);
        const data = await res.json();
        const page = Object.values(data.query?.pages || {})[0];
        const info = page?.imageinfo?.[0];
        return info?.thumburl || info?.url || null;
    } catch(e) { return null; }
}

// ---- Search-based fallback ------------------------------------------
async function fetchImageBySearch(make, model, year) {
    const makeTC  = titleCase(make);
    const modelTC = titleCase(model);
    const yearInt = parseInt(year, 10);

    const queries = [
        `${year} ${makeTC} ${modelTC}`,
        `${makeTC} ${modelTC}`,
    ];

    for (const query of queries) {
        try {
            const params = new URLSearchParams({
                action: "query", generator: "search",
                gsrsearch: query, gsrnamespace: "0", gsrlimit: "10",
                prop: "pageimages", pithumbsize: "640",
                format: "json", origin: "*"
            });
            const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`);
            if (!res.ok) continue;
            const data  = await res.json();
            const pages = Object.values(data.query?.pages || {})
                .filter(p => p.thumbnail?.source)
                .sort((a, b) => (a.index || 0) - (b.index || 0));
            if (!pages.length) continue;

            const makeResult = p => ({
                url:     p.thumbnail.source,
                pageUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}`
            });

            const exactYear = pages.find(p => p.title.includes(String(year)));
            if (exactYear) return makeResult(exactYear);

            const noYear = pages.find(p => !/\b(19|20)\d{2}\b/.test(p.title));
            if (noYear) return makeResult(noYear);

            const nearYear = pages.find(p => {
                const m = p.title.match(/\b((19|20)\d{2})\b/);
                return m && Math.abs(parseInt(m[1], 10) - yearInt) <= 3;
            });
            if (nearYear) return makeResult(nearYear);

        } catch(e) { console.error("Image search error:", e); }
    }
    return null;
}

// ================================================
// RECALL LOOKUP
// ================================================
async function checkRecalls(make, model, year) {
    const section = document.getElementById("recall-section");
    const btn     = document.getElementById("recallBtn");

    section.classList.remove("hidden");
    section.innerHTML = `<p class="loading">Checking NHTSA recall database…</p>`;
    btn.disabled = true;
    btn.textContent = "Checking…";

    try {
        const params  = new URLSearchParams({ make, model, modelYear: year });
        const res     = await fetch(`https://api.nhtsa.gov/recalls/recallsByVehicle?${params}`);
        if (!res.ok) throw new Error("Recall API failed");
        const recalls = (await res.json()).results || [];

        currentRecalls  = recalls; // store for PDF
        // Re-enable: from here on the button toggles the section open/closed
        btn.disabled    = false;
        btn.textContent = `⚠ ${recalls.length} Recall${recalls.length !== 1 ? "s" : ""} for this Model Year`;

        if (recalls.length === 0) {
            section.innerHTML = `<div class="recall-none">✓ No recalls found for this model year.</div>`;
            return;
        }
        // Recalls are matched by make/model/year — individual recalls may only
        // apply to certain VIN/build-date ranges within that model year.
        section.innerHTML = `<p class="recall-note">Recalls listed for this make, model, and year — not all may apply to this specific VIN.</p>` + recalls.map(r => `
            <div class="recall-card">
                <div class="recall-top">
                    <span class="recall-campaign">${escapeHtml(r.NHTSACampaignNumber || "")}</span>
                    <span class="recall-component">${escapeHtml(r.Component || "")}</span>
                </div>
                ${r.Summary     ? `<p class="recall-text">${escapeHtml(r.Summary)}</p>` : ""}
                ${r.Consequence ? `<p class="recall-text"><strong>Risk:</strong> ${escapeHtml(r.Consequence)}</p>` : ""}
                ${r.Remedy      ? `<p class="recall-text"><strong>Remedy:</strong> ${escapeHtml(r.Remedy)}</p>` : ""}
            </div>
        `).join("");

    } catch(err) {
        console.error(err);
        section.innerHTML = `<p class="recall-error">Failed to load recall data. Try again.</p>`;
        btn.textContent   = "⚠ Check Recalls (model year)";
        btn.disabled      = false;
    }
}

// ================================================
// PDF EXPORT
// ================================================
async function exportPDF() {
    if (!currentVin) return;

    const btn = document.getElementById("export-btn");
    btn.textContent = "Generating…";
    btn.disabled    = true;

    try {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ unit: "mm", format: "a4" });

        const margin = 15;
        const pageW  = 210;
        const pageH  = 297;
        const cw     = pageW - margin * 2;
        let   y      = margin;

        // Colors
        const COL_BLACK  = [17, 24, 39];
        const COL_GRAY   = [107, 114, 128];
        const COL_LGRAY  = [229, 231, 235];
        const COL_XGRAY  = [248, 249, 250];
        const COL_GREEN  = [5, 150, 105];
        const COL_AMBER  = [245, 158, 11];
        const COL_AMBERBG= [255, 251, 235];
        const COL_GREENBG= [240, 253, 244];
        const COL_GREENBD= [187, 247, 208];

        function checkPage(needed = 12) {
            if (y + needed > pageH - margin) { doc.addPage(); y = margin; }
        }

        function hline() {
            doc.setDrawColor(...COL_LGRAY);
            doc.setLineWidth(0.3);
            doc.line(margin, y, margin + cw, y);
            y += 4;
        }

        function sectionHeading(title) {
            checkPage(14);
            doc.setFillColor(...COL_LGRAY);
            doc.roundedRect(margin, y, cw, 8, 1.5, 1.5, "F");
            doc.setFontSize(8);
            doc.setFont("helvetica", "bold");
            doc.setTextColor(...COL_GRAY);
            doc.text(title.toUpperCase(), margin + 4, y + 5.5);
            y += 12;
        }

        function fieldGrid(fields) {
            const colW = (cw - 4) / 2;
            let col = 0;
            let rowY = y;

            for (const [label, value] of fields) {
                if (value === "N/A") continue;
                checkPage(16);
                if (col === 0) rowY = y;

                const x = margin + col * (colW + 4);
                doc.setFillColor(...COL_XGRAY);
                doc.roundedRect(x, rowY, colW, 14, 1.5, 1.5, "F");

                doc.setFontSize(7);
                doc.setFont("helvetica", "bold");
                doc.setTextColor(...COL_GRAY);
                doc.text(label.toUpperCase(), x + 3, rowY + 5);

                doc.setFont("helvetica", "normal");
                doc.setTextColor(...COL_BLACK);
                // Shrink font to fit the card width (min 6pt), ellipsize as last resort
                let text = String(value);
                let size = 9;
                doc.setFontSize(size);
                while (doc.getTextWidth(text) > colW - 6 && size > 6) {
                    size -= 0.5;
                    doc.setFontSize(size);
                }
                while (doc.getTextWidth(text) > colW - 6 && text.length > 2) {
                    text = text.slice(0, -2) + "…";
                }
                doc.text(text, x + 3, rowY + 11);

                if (col === 1) { y = rowY + 18; col = 0; }
                else           { col = 1; }
            }
            if (col === 1) y = rowY + 18;
            y += 3;
        }

        // ── Header ──
        doc.setFontSize(22);
        doc.setFont("helvetica", "bold");
        doc.setTextColor(...COL_BLACK);
        doc.text(`${currentYear} ${currentMake} ${currentModel}`, margin, y);
        y += 9;

        doc.setFontSize(10);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(...COL_GRAY);
        doc.text(`VIN: ${currentVin}`, margin, y);
        y += 5;

        doc.setFontSize(8);
        doc.text(`Generated ${new Date().toLocaleString()}`, margin, y);
        y += 6;

        hline();

        // ── Vehicle image ──
        if (currentImageUrl) {
            try {
                const imgRes  = await fetch(currentImageUrl);
                const blob    = await imgRes.blob();
                const b64     = await blobToBase64(blob);
                const ext     = blob.type.includes("png") ? "PNG" : "JPEG";
                const tmpImg  = new Image();
                await new Promise(r => { tmpImg.onload = r; tmpImg.onerror = r; tmpImg.src = b64; });
                if (tmpImg.naturalWidth > 0) {
                    const ratio  = tmpImg.naturalHeight / tmpImg.naturalWidth;
                    const imgW   = cw;
                    const imgH   = Math.min(imgW * ratio, 75);
                    checkPage(imgH + 8);
                    doc.addImage(b64, ext, margin, y, imgW, imgH, "", "FAST");
                    y += imgH + 8;
                }
            } catch(e) { /* image unavailable, continue */ }
        }

        // ── NHTSA sections ──
        for (const section of currentDecodedSections) {
            const hasData = section.fields.some(([, v]) => v !== "N/A");
            if (!hasData) continue;
            sectionHeading(section.heading);
            fieldGrid(section.fields);
        }

        // ── Recalls ──
        // Fetch now if user never clicked "Check Recalls"
        let recalls = currentRecalls;
        if (recalls === null) {
            try {
                const params = new URLSearchParams({ make: currentMake, model: currentModel, modelYear: currentYear });
                const res    = await fetch(`https://api.nhtsa.gov/recalls/recallsByVehicle?${params}`);
                recalls      = (await res.json()).results || [];
                currentRecalls = recalls;
            } catch(e) { recalls = null; }
        }

        checkPage(20);
        sectionHeading("NHTSA Recalls (Model Year)");

        if (recalls === null) {
            doc.setFontSize(9); doc.setFont("helvetica", "normal"); doc.setTextColor(...COL_GRAY);
            doc.text("Could not load recall data.", margin, y); y += 8;

        } else if (recalls.length === 0) {
            checkPage(12);
            doc.setFillColor(...COL_GREENBG);
            doc.setDrawColor(...COL_GREENBD);
            doc.setLineWidth(0.4);
            doc.roundedRect(margin, y, cw, 10, 1.5, 1.5, "FD");
            doc.setFontSize(9); doc.setFont("helvetica", "bold"); doc.setTextColor(...COL_GREEN);
            // No "✓" — glyph isn't in jsPDF's built-in helvetica encoding
            doc.text("No recalls found for this model year.", margin + 4, y + 7);
            y += 14;

        } else {
            for (const r of recalls) {
                const summaryLines = r.Summary     ? doc.splitTextToSize(r.Summary,     cw - 8) : [];
                const riskLines    = r.Consequence ? doc.splitTextToSize("Risk: " + r.Consequence, cw - 8) : [];
                const remedyLines  = r.Remedy      ? doc.splitTextToSize("Remedy: " + r.Remedy,    cw - 8) : [];
                const allLines     = [...summaryLines, ...riskLines, ...remedyLines];
                const cardH        = 10 + allLines.length * 4.5 + 4;

                checkPage(cardH + 4);

                doc.setFillColor(...COL_AMBERBG);
                doc.setDrawColor(...COL_AMBER);
                doc.setLineWidth(0.6);
                doc.roundedRect(margin, y, cw, cardH, 1.5, 1.5, "FD");

                doc.setFontSize(8); doc.setFont("helvetica", "bold"); doc.setTextColor(146, 64, 14);
                doc.text(r.NHTSACampaignNumber || "", margin + 4, y + 6);

                const campW = doc.getTextWidth(r.NHTSACampaignNumber || "") + 6;
                doc.setFontSize(9); doc.setFont("helvetica", "bold"); doc.setTextColor(...COL_BLACK);
                doc.text(r.Component || "", margin + 4 + campW, y + 6);

                let ry = y + 11;
                doc.setFontSize(8); doc.setFont("helvetica", "normal"); doc.setTextColor(...COL_GRAY);
                if (allLines.length) { doc.text(allLines, margin + 4, ry); }

                y += cardH + 4;
            }
        }

        doc.save(`VIN_${currentVin}_Report.pdf`);

    } catch(err) {
        console.error("PDF export failed:", err);
        alert("PDF export failed. Please try again.");
    } finally {
        btn.textContent = "Export PDF";
        btn.disabled    = false;
    }
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

// ================================================
// HELPERS
// ================================================
// Escapes quotes too, so output is safe in attribute values (e.g. data-vin="…")
function escapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
}

function hardRefresh() {
    const url = new URL(window.location.href);
    url.searchParams.set("refresh", Date.now());
    window.location.href = url.toString();
}

// ================================================
// SERVICE WORKER
// ================================================
if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("./serviceworker.js")
            .then(reg => console.log("SW registered:", reg.scope))
            .catch(err => console.error("SW failed:", err));
    });
}
