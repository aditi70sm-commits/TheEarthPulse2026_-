
/* =========================================
   EARTHPULSE - ENVIRONMENTAL INTELLIGENCE
   COMPLETE SCRIPT
   INDIA MAP + STATE COMPARISON
   + NASA GIBS SATELLITE MONITORING
   + CLIMATE INSIGHTS
========================================= */


/* =========================================
   1. GLOBAL VARIABLES
========================================= */

// India map
let indiaMap = null;
let indiaGeoLayer = null;
let selectedStateLayer = null;

// Satellite map - separate from India map
let satelliteMap = null;
let satelliteTileLayer = null;

// Main charts
let temperatureChart = null;
let rainfallChart = null;

// Comparison charts
let comparisonTemperatureChart = null;
let comparisonRainfallChart = null;

// Request tracking
let stateRequestId = 0;
let comparisonRequestId = 0;
let climateInsightsRequestId = 0;
let satelliteRequestId = 0;

// Selected state
let selectedStateName = null;
let stateLayersByName = new Map();


/* =========================================
   2. HELPER FUNCTIONS
========================================= */

function getElement(id) {
    return document.getElementById(id);
}


function updateText(id, value) {

    const element = getElement(id);

    if (element) {
        element.textContent = value;
    }
}


function escapeHTML(value) {

    return String(value).replace(/[&<>"']/g, function(char) {

        const entities = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        };

        return entities[char];
    });
}


function normalizeStateName(stateName) {

    return String(stateName)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .replace(/\s+/g, " ");
}


function getStateName(feature) {

    const properties = feature.properties || {};

    const rawStateName =
        properties.shapeName ||
        properties.NAME_1 ||
        properties.name ||
        properties.ST_NM ||
        properties.state ||
        properties.State ||
        "Unknown State";

    return normalizeStateName(rawStateName);
}


function safeNumber(value) {

    if (value === null || value === undefined || value === "") {
        return null;
    }

    const number = Number(value);

    return Number.isFinite(number) ? number : null;
}


function formatInsightValue(value) {

    if (value === null || value === undefined) {
        return "Unavailable";
    }

    if (typeof value === "number") {
        return Number.isFinite(value)
            ? Number(value.toFixed(2)).toString()
            : "Unavailable";
    }

    if (typeof value === "boolean") {
        return value ? "Yes" : "No";
    }

    if (Array.isArray(value)) {
        return value.length
            ? value.map(item => formatInsightValue(item)).join(", ")
            : "None";
    }

    if (typeof value === "object") {
        return JSON.stringify(value);
    }

    return String(value);
}


/* =========================================
   3. FETCH STATE ENVIRONMENTAL DATA
========================================= */

async function fetchStateEnvironmentalData(stateName) {

    try {

        console.log("Requesting data for:", stateName);

        const response = await fetch(
            `/api/state-trends?state=${encodeURIComponent(stateName)}`
        );

        const data = await response.json();

        console.log("State API response:", data);

        if (!response.ok) {
            throw new Error(
                data.error || "Unable to fetch state data."
            );
        }

        if (data.error) {
            throw new Error(data.error);
        }

        if (
            !Array.isArray(data.years) ||
            data.years.length === 0
        ) {
            throw new Error(
                "No environmental observations available."
            );
        }

        if (
            !Array.isArray(data.temperature) ||
            !Array.isArray(data.precipitation) ||
            data.temperature.length !== data.years.length ||
            data.precipitation.length !== data.years.length
        ) {
            throw new Error(
                "Temperature or precipitation data is incomplete."
            );
        }

        if (!data.analysis) {
            throw new Error(
                "Environmental trend analysis is missing."
            );
        }

        const lastIndex = data.years.length - 1;

        return {
            success: true,
            data: data,
            latestYear: data.years[lastIndex],
            temperature: safeNumber(data.temperature[lastIndex]),
            rainfall: safeNumber(data.precipitation[lastIndex])
        };

    } catch (error) {

        console.error("State data error:", error);

        return {
            success: false,
            error: error.message
        };
    }
}


/* =========================================
   4. INITIALIZE INTERACTIVE INDIA MAP
========================================= */

async function initializeIndiaMap() {

    const mapElement = getElement("indiaMap");

    if (!mapElement) {
        console.error("India map element not found.");
        return;
    }

    if (typeof L === "undefined") {

        console.error("Leaflet library is missing.");

        updateText(
            "selectedLocation",
            "Map unavailable: Leaflet library not loaded."
        );

        return;
    }

    try {

        if (indiaMap) {
            indiaMap.remove();
            indiaMap = null;
        }

        stateLayersByName.clear();

        indiaMap = L.map("indiaMap", {
            zoomControl: true,
            scrollWheelZoom: true
        });

        L.tileLayer(
            "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
            {
                attribution:
                    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
                maxZoom: 12
            }
        ).addTo(indiaMap);


        const response = await fetch(
            "/static/data/india-states.geojson"
        );

        if (!response.ok) {
            throw new Error(
                "India state boundary file could not be loaded."
            );
        }

        const geoData = await response.json();

        if (
            !geoData.features ||
            geoData.features.length === 0
        ) {
            throw new Error(
                "No Indian state boundaries found."
            );
        }


        indiaGeoLayer = L.geoJSON(geoData, {

            style: function() {

                return {
                    color: "#5ee6b5",
                    weight: 1.5,
                    fillColor: "#176477",
                    fillOpacity: 0.65
                };
            },


            onEachFeature: function(feature, layer) {

                const stateName = getStateName(feature);

                stateLayersByName.set(stateName, layer);

                layer.bindTooltip(stateName, {
                    sticky: true,
                    direction: "top"
                });


                // STATE CLICK EVENT

                layer.on("click", async function() {

                    const currentRequestId = ++stateRequestId;

                    selectedStateName = stateName;

                    const searchBox = getElement("stateSearch");

                    if (searchBox) {
                        searchBox.value = stateName;
                    }

                    console.log("Selected state:", stateName);


                    updateText(
                        "dashboardLocation",
                        "📍 " + stateName + ", India"
                    );

                    updateText(
                        "selectedLocation",
                        "Selected Location: " + stateName
                    );

                    updateText(
                        "status",
                        "Loading environmental data for " +
                        stateName + "..."
                    );


                    if (selectedStateLayer) {

                        indiaGeoLayer.resetStyle(
                            selectedStateLayer
                        );
                    }


                    selectedStateLayer = layer;

                    layer.setStyle({
                        color: "#ffffff",
                        weight: 3,
                        fillColor: "#5ee6b5",
                        fillOpacity: 0.85
                    });

                    layer.bringToFront();


                    layer.bindPopup(`
                        <div class="environment-popup">

                            <h3>🌿 ${escapeHTML(stateName)}</h3>

                            <hr>

                            <p>Loading environmental data...</p>

                        </div>
                    `, {
                        className: "environment-popup-container",
                        maxWidth: 280
                    }).openPopup();


                    const result =
                        await fetchStateEnvironmentalData(stateName);


                    if (currentRequestId !== stateRequestId) {
                        return;
                    }


                    let popupContent;


                    if (result.success) {

                        const data = result.data;

                        updateInsights(data);

                        createTemperatureChart(data);

                        createRainfallChart(data);


                        updateText(
                            "dashboardLocation",
                            "📍 " + stateName + ", India"
                        );

                        updateText(
                            "status",
                            "Environmental data successfully loaded for " +
                            stateName + ", India"
                        );


                        popupContent = `
                            <div class="environment-popup">

                                <h3>🌿 ${escapeHTML(stateName)}</h3>

                                <hr>

                                <p><strong>Latest Year:</strong>
                                ${escapeHTML(result.latestYear)}</p>

                                <p><strong>Temperature:</strong>
                                ${result.temperature ?? "Unavailable"} °C</p>

                                <p><strong>Precipitation:</strong>
                                ${result.rainfall ?? "Unavailable"} mm</p>

                                <p><strong>Monitoring Status:</strong>
                                Data loaded successfully</p>

                            </div>
                        `;

                    } else {

                        updateText(
                            "status",
                            "Unable to load environmental data for " +
                            stateName + ": " + result.error
                        );

                        popupContent = `
                            <div class="environment-popup">

                                <h3>🌿 ${escapeHTML(stateName)}</h3>

                                <hr>

                                <p>Environmental data could not be loaded.</p>

                                <p>${escapeHTML(result.error)}</p>

                            </div>
                        `;
                    }


                    layer.setPopupContent(popupContent);

                });

            }

        }).addTo(indiaMap);


        indiaMap.fitBounds(
            [
                [6.5, 68.0],
                [37.5, 97.5]
            ],
            {
                padding: [20, 20],
                maxZoom: 5
            }
        );


        setTimeout(function() {

            if (indiaMap) {
                indiaMap.invalidateSize();
            }

        }, 300);


        updateText(
            "selectedLocation",
            "Select an Indian state to explore."
        );


        console.log(
            "EARTHPULSE India map loaded successfully."
        );


    } catch (error) {

        console.error("India map error:", error);

        updateText(
            "selectedLocation",
            "Map error: " + error.message
        );
    }
}


/* =========================================
   5. LOAD DEFAULT ENVIRONMENTAL DATA
========================================= */

async function loadEarthData() {

    if (selectedStateName !== null) {

        console.log(
            "Default data skipped. Selected state:",
            selectedStateName
        );

        return;
    }


    updateText(
        "status",
        "Fetching NASA environmental observations..."
    );


    try {

        const response = await fetch("/api/trends");

        if (!response.ok) {
            throw new Error(
                "Environmental data request failed. Status: " +
                response.status
            );
        }


        const data = await response.json();


        if (selectedStateName !== null) {
            return;
        }

        if (data.error) {
            throw new Error(data.error);
        }

        if (
            !Array.isArray(data.years) ||
            data.years.length === 0
        ) {
            throw new Error(
                "No yearly environmental observations available."
            );
        }

        if (!data.analysis) {
            throw new Error(
                "Trend analysis is missing from API response."
            );
        }


        updateText(
            "dashboardLocation",
            "📍 " + (data.location || "Default Location")
        );

        updateText(
            "status",
            "Environmental data successfully loaded for " +
            (data.location || "default location")
        );


        updateInsights(data);

        createTemperatureChart(data);

        createRainfallChart(data);


        console.log(
            "EARTHPULSE default environmental data loaded successfully."
        );


    } catch (error) {

        if (selectedStateName === null) {

            updateText(
                "status",
                "Error: " + error.message
            );
        }

        console.error(
            "Environmental dashboard error:",
            error
        );
    }
}


/* =========================================
   6. UPDATE ENVIRONMENTAL INSIGHTS
========================================= */

function updateInsights(data) {

    const analysis = data.analysis || {};

    const temperature = analysis.temperature || {};

    const rainfall = analysis.precipitation || {};


    updateText(
        "temperatureTrend",
        temperature.direction || "Unavailable"
    );

    updateText(
        "temperatureSlope",
        temperature.slope == null
            ? "Slope unavailable"
            : "Change: " + temperature.slope + " °C/year"
    );


    updateText(
        "rainfallTrend",
        rainfall.direction || "Unavailable"
    );

    updateText(
        "rainfallSlope",
        rainfall.slope == null
            ? "Slope unavailable"
            : "Change: " + rainfall.slope + " mm/year"
    );


    const temperatureAnomalies =
        temperature.anomalies || [];

    const rainfallAnomalies =
        rainfall.anomalies || [];


    const totalAnomalies =
        temperatureAnomalies.length +
        rainfallAnomalies.length;


    updateText(
        "anomalyCount",
        totalAnomalies + " statistical outliers detected"
    );


    updateText(
        "temperatureInsight",

        "The annual average temperature trend is " +
        (temperature.direction || "unavailable").toLowerCase() +
        ". The estimated linear change is " +

        (temperature.slope == null
            ? "unavailable."
            : temperature.slope + " °C per year.")
    );


    updateText(
        "rainfallInsight",

        "The annual precipitation trend is " +
        (rainfall.direction || "unavailable").toLowerCase() +
        ". The estimated linear change is " +

        (rainfall.slope == null
            ? "unavailable."
            : rainfall.slope + " mm per year.")
    );


    const anomalyDetails = getElement("anomalyDetails");

    if (!anomalyDetails) {
        return;
    }


    anomalyDetails.innerHTML = "";


    if (totalAnomalies === 0) {

        anomalyDetails.textContent =
            "No statistical outliers detected using the IQR method.";

    } else {

        const heading = document.createElement("p");

        heading.textContent =
            "Statistical outliers identified:";

        anomalyDetails.appendChild(heading);


        addAnomalyList(
            anomalyDetails,
            "Temperature",
            temperatureAnomalies,
            "°C"
        );

        addAnomalyList(
            anomalyDetails,
            "Precipitation",
            rainfallAnomalies,
            "mm"
        );
    }
}


/* =========================================
   7. DISPLAY ANOMALY INFORMATION
========================================= */

function addAnomalyList(container, title, anomalies, unit) {

    const heading = document.createElement("h4");

    heading.textContent = title;

    container.appendChild(heading);


    if (!anomalies || anomalies.length === 0) {

        const message = document.createElement("p");

        message.textContent = "No outliers detected.";

        container.appendChild(message);

        return;
    }


    const list = document.createElement("ul");


    anomalies.forEach(function(item) {

        const li = document.createElement("li");

        li.textContent =
            item.year + ": " + item.value + " " + unit;

        list.appendChild(li);

    });


    container.appendChild(list);
}


/* =========================================
   8. TEMPERATURE LINE CHART
========================================= */

function createTemperatureChart(data) {

    const canvas = getElement("temperatureChart");

    if (!canvas || typeof Chart === "undefined") {
        return;
    }

    if (temperatureChart) {
        temperatureChart.destroy();
    }


    temperatureChart = new Chart(canvas, {

        type: "line",

        data: {

            labels: data.years,

            datasets: [{

                label: "Temperature (°C)",

                data: data.temperature,

                borderColor: "#5ee6b5",

                backgroundColor: "rgba(94, 230, 181, 0.15)",

                fill: true,

                tension: 0.3,

                spanGaps: false
            }]
        },


        options: {

            responsive: true,

            maintainAspectRatio: false,

            plugins: {

                legend: {
                    labels: {
                        color: "#ffffff"
                    }
                }
            },

            scales: {

                x: {
                    ticks: {
                        color: "#ffffff"
                    }
                },

                y: {
                    ticks: {
                        color: "#ffffff"
                    }
                }
            }
        }
    });
}


/* =========================================
   9. RAINFALL BAR CHART
========================================= */

function createRainfallChart(data) {

    const canvas = getElement("rainfallChart");

    if (!canvas || typeof Chart === "undefined") {
        return;
    }

    if (rainfallChart) {
        rainfallChart.destroy();
    }


    rainfallChart = new Chart(canvas, {

        type: "bar",

        data: {

            labels: data.years,

            datasets: [{

                label: "Precipitation (mm)",

                data: data.precipitation,

                backgroundColor: "#45b9e8",

                borderRadius: 5
            }]
        },


        options: {

            responsive: true,

            maintainAspectRatio: false,

            plugins: {

                legend: {
                    labels: {
                        color: "#ffffff"
                    }
                }
            },

            scales: {

                x: {
                    ticks: {
                        color: "#ffffff"
                    }
                },

                y: {
                    ticks: {
                        color: "#ffffff"
                    }
                }
            }
        }
    });
}


/* =========================================
   10. STATE SEARCH
========================================= */

function initializeStateSearch() {

    const searchBox = getElement("stateSearch");

    const dataList = getElement("indiaStates");

    if (!searchBox || !dataList) {
        console.error("State search elements not found.");
        return;
    }


    dataList.innerHTML = "";


    stateLayersByName.forEach(function(layer, stateName) {

        const option = document.createElement("option");

        option.value = stateName;

        dataList.appendChild(option);

    });


    searchBox.addEventListener("change", function() {

        const stateName =
            normalizeStateName(searchBox.value);

        const stateLayer =
            stateLayersByName.get(stateName);


        if (!stateLayer) {

            updateText(
                "status",
                "Please select a valid Indian state."
            );

            return;
        }


        stateLayer.fire("click");


        if (indiaMap) {

            indiaMap.fitBounds(
                stateLayer.getBounds(),
                {
                    padding: [30, 30],
                    maxZoom: 7
                }
            );
        }

    });

}


/* =========================================
   11. INITIALIZE COMPARISON DROPDOWNS
========================================= */

function initializeComparison() {

    const select1 = getElement("compareState1");

    const select2 = getElement("compareState2");

    const button = getElement("compareButton");


    if (!select1 || !select2 || !button) {

        console.error(
            "Comparison interface elements are missing."
        );

        return;
    }


    const stateNames = Array.from(
        stateLayersByName.keys()
    ).sort();


    [select1, select2].forEach(function(select) {

        select.innerHTML =
            '<option value="">Select a state</option>';


        stateNames.forEach(function(stateName) {

            const option = document.createElement("option");

            option.value = stateName;

            option.textContent = stateName;

            select.appendChild(option);

        });

    });


    const rajasthan = stateNames.find(
        name => normalizeStateName(name).toLowerCase() === "rajasthan"
    );

    const jharkhand = stateNames.find(
        name => normalizeStateName(name).toLowerCase() === "jharkhand"
    );


    if (rajasthan) {
        select1.value = rajasthan;
    }

    if (jharkhand) {
        select2.value = jharkhand;
    }


    button.addEventListener(
        "click",
        compareSelectedStates
    );


    console.log(
        "State comparison dropdowns initialized."
    );
}


/* =========================================
   12. COMPARE TWO SELECTED STATES
========================================= */

async function compareSelectedStates() {

    const state1 = getElement("compareState1").value;

    const state2 = getElement("compareState2").value;


    if (!state1 || !state2) {

        updateText(
            "comparisonStatus",
            "Please select both states before comparing."
        );

        return;
    }


    if (
        normalizeStateName(state1).toLowerCase() ===
        normalizeStateName(state2).toLowerCase()
    ) {

        updateText(
            "comparisonStatus",
            "Please select two different states."
        );

        return;
    }


    const currentRequestId = ++comparisonRequestId;


    updateText(
        "comparisonStatus",
        "Loading climate observations for " +
        state1 + " and " + state2 + "..."
    );


    updateText(
        "temperatureComparison",
        "Fetching temperature data..."
    );

    updateText(
        "rainfallComparison",
        "Fetching rainfall data..."
    );

    updateText(
        "climateComparisonInsight",
        "Analyzing climate differences..."
    );


    const button = getElement("compareButton");

    button.disabled = true;

    button.textContent = "Comparing...";


    try {

        const results = await Promise.all([

            fetchStateEnvironmentalData(state1),

            fetchStateEnvironmentalData(state2)

        ]);


        if (currentRequestId !== comparisonRequestId) {
            return;
        }


        const firstResult = results[0];

        const secondResult = results[1];


        if (!firstResult.success) {

            throw new Error(
                state1 + ": " + firstResult.error
            );
        }


        if (!secondResult.success) {

            throw new Error(
                state2 + ": " + secondResult.error
            );
        }


        const firstData = firstResult.data;

        const secondData = secondResult.data;


        createComparisonTemperatureChart(
            state1,
            firstData,
            state2,
            secondData
        );


        createComparisonRainfallChart(
            state1,
            firstData,
            state2,
            secondData
        );


        generateComparisonInsights(
            state1,
            firstData,
            state2,
            secondData
        );


        updateText(
            "comparisonStatus",
            "Climate comparison successfully completed: " +
            state1 + " vs " + state2
        );


        console.log(
            "Climate comparison completed:",
            state1,
            state2
        );


    } catch (error) {

        console.error(
            "Comparison error:",
            error
        );


        updateText(
            "comparisonStatus",
            "Comparison failed: " + error.message
        );

    } finally {

        if (currentRequestId === comparisonRequestId) {

            button.disabled = false;

            button.textContent = "Compare Climate";
        }
    }
}


/* =========================================
   13. PREPARE COMMON YEAR DATA
========================================= */

function prepareComparisonData(
    firstData,
    secondData,
    parameter
) {

    const firstMap = new Map();

    const secondMap = new Map();


    firstData.years.forEach(function(year, index) {

        firstMap.set(
            String(year),
            safeNumber(firstData[parameter][index])
        );

    });


    secondData.years.forEach(function(year, index) {

        secondMap.set(
            String(year),
            safeNumber(secondData[parameter][index])
        );

    });


    const commonYears = Array.from(firstMap.keys())
        .filter(year => secondMap.has(year))
        .sort((a, b) => Number(a) - Number(b));


    if (commonYears.length === 0) {

        throw new Error(
            "The selected states have no common observation years."
        );
    }


    return {

        years: commonYears,

        firstValues: commonYears.map(
            year => firstMap.get(year)
        ),

        secondValues: commonYears.map(
            year => secondMap.get(year)
        )
    };
}


/* =========================================
   14. TEMPERATURE COMPARISON CHART
========================================= */

function createComparisonTemperatureChart(
    state1,
    data1,
    state2,
    data2
) {

    const canvas = getElement(
        "comparisonTemperatureChart"
    );


    if (!canvas || typeof Chart === "undefined") {
        return;
    }


    const comparison = prepareComparisonData(
        data1,
        data2,
        "temperature"
    );


    if (comparisonTemperatureChart) {
        comparisonTemperatureChart.destroy();
    }


    comparisonTemperatureChart = new Chart(canvas, {

        type: "line",

        data: {

            labels: comparison.years,

            datasets: [

                {

                    label: state1 + " (°C)",

                    data: comparison.firstValues,

                    borderColor: "#5ee6b5",

                    backgroundColor: "rgba(94, 230, 181, 0.10)",

                    tension: 0.3,

                    fill: false,

                    spanGaps: false
                },

                {

                    label: state2 + " (°C)",

                    data: comparison.secondValues,

                    borderColor: "#45b9e8",

                    backgroundColor: "rgba(69, 185, 232, 0.10)",

                    tension: 0.3,

                    fill: false,

                    spanGaps: false
                }

            ]
        },


        options: {

            responsive: true,

            maintainAspectRatio: false,

            interaction: {
                mode: "index",
                intersect: false
            },

            plugins: {

                legend: {
                    labels: {
                        color: "#ffffff"
                    }
                },

                tooltip: {
                    enabled: true
                }
            },

            scales: {

                x: {
                    title: {
                        display: true,
                        text: "Year",
                        color: "#ffffff"
                    },

                    ticks: {
                        color: "#ffffff"
                    }
                },

                y: {

                    title: {
                        display: true,
                        text: "Temperature (°C)",
                        color: "#ffffff"
                    },

                    ticks: {
                        color: "#ffffff"
                    }
                }
            }
        }
    });
}


/* =========================================
   15. RAINFALL COMPARISON CHART
========================================= */

function createComparisonRainfallChart(
    state1,
    data1,
    state2,
    data2
) {

    const canvas = getElement(
        "comparisonRainfallChart"
    );


    if (!canvas || typeof Chart === "undefined") {
        return;
    }


    const comparison = prepareComparisonData(
        data1,
        data2,
        "precipitation"
    );


    if (comparisonRainfallChart) {
        comparisonRainfallChart.destroy();
    }


    comparisonRainfallChart = new Chart(canvas, {

        type: "bar",

        data: {

            labels: comparison.years,

            datasets: [

                {

                    label: state1 + " (mm)",

                    data: comparison.firstValues,

                    backgroundColor: "#5ee6b5",

                    borderRadius: 4
                },

                {

                    label: state2 + " (mm)",

                    data: comparison.secondValues,

                    backgroundColor: "#45b9e8",

                    borderRadius: 4
                }

            ]
        },


        options: {

            responsive: true,

            maintainAspectRatio: false,

            interaction: {
                mode: "index",
                intersect: false
            },

            plugins: {

                legend: {
                    labels: {
                        color: "#ffffff"
                    }
                }
            },

            scales: {

                x: {
                    title: {
                        display: true,
                        text: "Year",
                        color: "#ffffff"
                    },

                    ticks: {
                        color: "#ffffff"
                    }
                },

                y: {

                    title: {
                        display: true,
                        text: "Precipitation (mm)",
                        color: "#ffffff"
                    },

                    ticks: {
                        color: "#ffffff"
                    }
                }
            }
        }
    });
}


/* =========================================
   16. GENERATE CLIMATE COMPARISON INSIGHTS
========================================= */

function generateComparisonInsights(
    state1,
    data1,
    state2,
    data2
) {

    const comparisonYears = prepareComparisonData(
        data1,
        data2,
        "temperature"
    );


    const rainfallYears = prepareComparisonData(
        data1,
        data2,
        "precipitation"
    );


    const latestTemperatureIndex =
        comparisonYears.years.length - 1;


    const temperature1 =
        comparisonYears.firstValues[latestTemperatureIndex];

    const temperature2 =
        comparisonYears.secondValues[latestTemperatureIndex];


    const latestRainfallIndex =
        rainfallYears.years.length - 1;


    const rainfall1 =
        rainfallYears.firstValues[latestRainfallIndex];

    const rainfall2 =
        rainfallYears.secondValues[latestRainfallIndex];


    const latestYear =
        comparisonYears.years[latestTemperatureIndex];


    let temperatureMessage;

    if (temperature1 === null || temperature2 === null) {

        temperatureMessage =
            "Latest comparable temperature values are unavailable.";

    } else {

        const difference = Math.abs(
            temperature1 - temperature2
        ).toFixed(2);


        if (temperature1 > temperature2) {

            temperatureMessage =
                state1 + " recorded a higher annual temperature than " +
                state2 + " in " + latestYear +
                ", with a difference of " + difference + " °C.";

        } else if (temperature2 > temperature1) {

            temperatureMessage =
                state2 + " recorded a higher annual temperature than " +
                state1 + " in " + latestYear +
                ", with a difference of " + difference + " °C.";

        } else {

            temperatureMessage =
                "Both states recorded the same annual temperature in " +
                latestYear + ".";
        }
    }


    let rainfallMessage;

    if (rainfall1 === null || rainfall2 === null) {

        rainfallMessage =
            "Latest comparable rainfall values are unavailable.";

    } else {

        const difference = Math.abs(
            rainfall1 - rainfall2
        ).toFixed(2);


        if (rainfall1 > rainfall2) {

            rainfallMessage =
                state1 + " recorded higher annual precipitation than " +
                state2 + " in " + latestYear +
                ", with a difference of " + difference + " mm.";

        } else if (rainfall2 > rainfall1) {

            rainfallMessage =
                state2 + " recorded higher annual precipitation than " +
                state1 + " in " + latestYear +
                ", with a difference of " + difference + " mm.";

        } else {

            rainfallMessage =
                "Both states recorded the same annual precipitation in " +
                latestYear + ".";
        }
    }


    updateText(
        "temperatureComparison",
        temperatureMessage
    );


    updateText(
        "rainfallComparison",
        rainfallMessage
    );


    const tempTrend1 =
        data1.analysis.temperature.direction || "Unavailable";

    const tempTrend2 =
        data2.analysis.temperature.direction || "Unavailable";


    const rainfallTrend1 =
        data1.analysis.precipitation.direction || "Unavailable";

    const rainfallTrend2 =
        data2.analysis.precipitation.direction || "Unavailable";


    const insight =

        "Temperature trend: " + state1 + " is " +
        tempTrend1 + ", while " + state2 + " is " +
        tempTrend2 + ". " +

        "Rainfall trend: " + state1 + " is " +
        rainfallTrend1 + ", while " + state2 + " is " +
        rainfallTrend2 + ". " +

        "These observations represent the selected coordinates " +
        "and should not be interpreted as official state-wide averages.";


    updateText(
        "climateComparisonInsight",
        insight
    );


    console.log(
        "Comparison insights generated successfully."
    );
}


/* =========================================
   17. SATELLITE MONITORING
   NASA GIBS IMAGERY
========================================= */

// Initialize the separate satellite map.

function initializeSatelliteMap() {

    const mapElement = getElement("satelliteMap");

    if (!mapElement) {
        console.warn("Satellite map element not found.");
        return;
    }

    if (typeof L === "undefined") {
        updateText(
            "satelliteStatus",
            "Satellite map unavailable: Leaflet is not loaded."
        );
        return;
    }

    try {

        if (satelliteMap) {
            satelliteMap.remove();
            satelliteMap = null;
            satelliteTileLayer = null;
        }

        satelliteMap = L.map("satelliteMap", {
            center: [22.5, 82.0],
            zoom: 4,
            minZoom: 3,
            maxZoom: 10,
            scrollWheelZoom: true
        });

        // Base map.

        L.tileLayer(
            "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
            {
                attribution:
                    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
                maxZoom: 10
            }
        ).addTo(satelliteMap);

        setTimeout(function() {

            if (satelliteMap) {
                satelliteMap.invalidateSize();
            }

        }, 400);

        console.log("Satellite map initialized.");

    } catch (error) {

        console.error("Satellite map initialization error:", error);

        updateText(
            "satelliteStatus",
            "Satellite map error: " + error.message
        );
    }
}


// Set default satellite date.

function initializeSatelliteControls() {

    const dateInput = getElement("satelliteDate");

    const layerSelect = getElement("satelliteLayer");

    const loadButton = getElement("loadSatelliteButton");

    if (!dateInput || !layerSelect || !loadButton) {
        console.warn("Satellite controls are missing.");
        return;
    }

    const today = new Date();

    const formattedDate =
        today.getFullYear() + "-" +
        String(today.getMonth() + 1).padStart(2, "0") + "-" +
        String(today.getDate()).padStart(2, "0");

    dateInput.max = formattedDate;

    if (!dateInput.value) {
        dateInput.value = formattedDate;
    }

    loadButton.addEventListener(
        "click",
        loadSatelliteImagery
    );

    console.log("Satellite controls initialized.");
}


// Load NASA GIBS satellite imagery.


async function loadSatelliteImagery() {

    const dateInput = getElement("satelliteDate");
    const layerSelect = getElement("satelliteLayer");
    const loadButton = getElement("loadSatelliteButton");

    if (!dateInput || !layerSelect) {
        updateText("satelliteStatus", "Satellite controls could not be found.");
        return;
    }

    const selectedDate = dateInput.value;
    const selectedLayer = layerSelect.value;

    if (!selectedDate) {
        updateText("satelliteStatus", "Please select an observation date.");
        return;
    }

    if (!selectedLayer) {
        updateText("satelliteStatus", "Please select a satellite layer.");
        return;
    }

    // Prevent future dates
    if (selectedDate > new Date().toLocaleDateString("en-CA")) {
        updateText("satelliteStatus", "Future satellite dates are not allowed.");
        return;
    }

    const currentRequestId = ++satelliteRequestId;

    updateText(
        "satelliteStatus",
        "Requesting NASA GIBS satellite imagery..."
    );

    if (loadButton) {
        loadButton.disabled = true;
        loadButton.textContent = "Loading imagery...";
    }

    try {

        const apiUrl =
            "/api/satellite-config?date=" +
            encodeURIComponent(selectedDate) +
            "&layer=" +
            encodeURIComponent(selectedLayer);

        const response = await fetch(apiUrl);

        const data = await response.json();

        if (currentRequestId !== satelliteRequestId) {
            return;
        }

        if (!response.ok || data.error || !data.success) {
            throw new Error(
                data.error || "Satellite imagery request failed."
            );
        }

        const tileUrl = data.tile_url || data.url;

        if (!tileUrl) {
            throw new Error("NASA GIBS tile URL is missing.");
        }

        if (!satelliteMap) {
            initializeSatelliteMap();
        }

        if (!satelliteMap) {
            throw new Error("Satellite map could not be initialized.");
        }

        // Remove previous satellite layer
        if (satelliteTileLayer) {
            satelliteMap.removeLayer(satelliteTileLayer);
            satelliteTileLayer = null;
        }

        // Track successful and failed tile requests
        let tileErrorCount = 0;
        let tileLoadCount = 0;

        // Create NASA GIBS layer
        satelliteTileLayer = L.tileLayer(tileUrl, {

            attribution:
                'Imagery: <a href="https://earthdata.nasa.gov/">NASA Earthdata GIBS</a>',

            minZoom: 2,
            maxZoom: 10,
            maxNativeZoom: 9,
            tileSize: 256,
            crossOrigin: true

        });

        // Attach listeners BEFORE adding the layer
        satelliteTileLayer.on("loading", function() {

            tileErrorCount = 0;
            tileLoadCount = 0;

            if (currentRequestId === satelliteRequestId) {
                updateText(
                    "satelliteStatus",
                    "Downloading NASA satellite imagery..."
                );
            }
        });

        satelliteTileLayer.on("tileload", function() {
            tileLoadCount++;
        });

        satelliteTileLayer.on("tileerror", function(error) {

            tileErrorCount++;

            console.warn(
                "NASA GIBS tile loading error:",
                error
            );

        });

        satelliteTileLayer.on("load", function() {

            if (currentRequestId !== satelliteRequestId) {
                return;
            }

            if (tileLoadCount === 0) {

                updateText(
                    "satelliteStatus",
                    "No satellite imagery tiles loaded. Try another date."
                );

            } else if (tileErrorCount > 0) {

                updateText(
                    "satelliteStatus",
                    "Satellite imagery partially loaded. Some tiles failed."
                );

            } else {

                updateText(
                    "satelliteStatus",
                    "NASA GIBS imagery loaded successfully. Date: " +
                    selectedDate
                );

            }

        });

        // Add the layer to the map
        satelliteTileLayer.addTo(satelliteMap);

        // Refresh map dimensions
        setTimeout(function() {

            if (satelliteMap) {
                satelliteMap.invalidateSize();
            }

        }, 300);

        updateText(
            "satelliteInfo",
            "Satellite: " +
            (data.layer_name || selectedLayer) +
            " | Date: " +
            (data.date || selectedDate) +
            " | Source: NASA GIBS"
        );

        console.log(
            "NASA GIBS satellite layer requested:",
            data
        );

    } catch (error) {

        console.error("Satellite imagery error:", error);

        if (currentRequestId === satelliteRequestId) {

            updateText(
                "satelliteStatus",
                "Unable to load satellite imagery: " + error.message
            );
        }

    } finally {

        if (
            currentRequestId === satelliteRequestId &&
            loadButton
        ) {
            loadButton.disabled = false;
            loadButton.textContent = "Load Satellite Imagery";
        }
    }
}


/* =========================================
   18. CLIMATE INSIGHTS
========================================= */

// Populate climate insights state dropdown.

function initializeClimateInsights() {

    const stateSelect = getElement("insightState");

    const loadButton = getElement("loadClimateInsightsButton");

    if (!stateSelect || !loadButton) {
        console.warn("Climate insights controls are missing.");
        return;
    }

    const stateNames = Array.from(
        stateLayersByName.keys()
    ).sort();

    const previousValue = stateSelect.value;

    stateSelect.innerHTML = "";

    stateNames.forEach(function(stateName) {

        const option = document.createElement("option");

        option.value = stateName;

        option.textContent = stateName;

        stateSelect.appendChild(option);

    });

    if (
        previousValue &&
        stateNames.includes(previousValue)
    ) {
        stateSelect.value = previousValue;

    } else if (
        selectedStateName &&
        stateNames.includes(selectedStateName)
    ) {
        stateSelect.value = selectedStateName;

    } else if (
        stateNames.includes("Bihar")
    ) {
        stateSelect.value = "Bihar";

    } else if (stateNames.length > 0) {
        stateSelect.value = stateNames[0];
    }

    loadButton.addEventListener(
        "click",
        loadClimateInsights
    );

    console.log("Climate insights controls initialized.");
}


// Load insights from the Flask API.

async function loadClimateInsights() {

    const stateSelect = getElement("insightState");

    const loadButton = getElement("loadClimateInsightsButton");

    const container = getElement("climateInsightsContainer");

    if (!stateSelect || !container) {
        console.warn("Climate insights interface is incomplete.");
        return;
    }

    const stateName = stateSelect.value;

    if (!stateName) {
        updateText(
            "climateInsightsStatus",
            "Please select a state."
        );
        return;
    }

    const currentRequestId = ++climateInsightsRequestId;

    updateText(
        "climateInsightsStatus",
        "Analyzing climate observations for " + stateName + "..."
    );

    if (loadButton) {
        loadButton.disabled = true;
        loadButton.textContent = "Analyzing...";
    }

    try {

        const response = await fetch(
            "/api/climate-insights?state=" +
            encodeURIComponent(stateName)
        );

        const data = await response.json();

        if (currentRequestId !== climateInsightsRequestId) {
            return;
        }

        if (!response.ok || data.error) {
            throw new Error(
                data.error || "Climate insights request failed."
            );
        }

        console.log(
            "Climate insights API response:",
            data
        );

        renderClimateInsights(data, stateName);

        updateText(
            "climateInsightsStatus",
            "Climate insights loaded successfully for " +
            stateName + ", India."
        );

    } catch (error) {

        console.error(
            "Climate insights error:",
            error
        );

        if (currentRequestId === climateInsightsRequestId) {

            updateText(
                "climateInsightsStatus",
                "Unable to load climate insights: " + error.message
            );
        }

    } finally {

        if (currentRequestId === climateInsightsRequestId && loadButton) {

            loadButton.disabled = false;

            loadButton.textContent = "Generate Climate Insights";
        }
    }
}


// Convert API data into readable insight cards.
// Supports strings, arrays and nested objects.

function renderClimateInsights(data, stateName) {

    const container = getElement("climateInsightsContainer");

    if (!container) {
        return;
    }

    container.innerHTML = "";

    const insights =
        data.climate_insights ||
        data.insights ||
        data.analysis ||
        data;

    const cards = [];

    function collectInsights(value, title, depth) {

        if (depth > 3 || value === null || value === undefined) {
            return;
        }

        if (Array.isArray(value)) {

            if (value.length === 0) {
                return;
            }

            value.forEach(function(item, index) {

                if (
                    item !== null &&
                    typeof item === "object"
                ) {
                    collectInsights(
                        item,
                        title + " " + (index + 1),
                        depth + 1
                    );

                } else {

                    cards.push({
                        title: title + " " + (index + 1),
                        text: formatInsightValue(item)
                    });
                }

            });

            return;
        }

        if (typeof value === "object") {

            Object.entries(value).forEach(function([key, item]) {

                const formattedTitle = key
                    .replace(/_/g, " ")
                    .replace(/\b\w/g, letter => letter.toUpperCase());

                collectInsights(
                    item,
                    formattedTitle,
                    depth + 1
                );

            });

            return;
        }

        cards.push({
            title: title,
            text: formatInsightValue(value)
        });
    }


    if (
        typeof insights === "string" ||
        typeof insights === "number"
    ) {

        cards.push({
            title: "Climate Overview",
            text: formatInsightValue(insights)
        });

    } else {

        collectInsights(
            insights,
            "Climate Insight",
            0
        );
    }


    // Exclude general metadata from the displayed cards.

    const ignoredKeys = [
        "state",
        "country",
        "cached",
        "errors",
        "failed_locations",
        "data_note"
    ];

    const filteredCards = cards.filter(function(card) {

        return !ignoredKeys.includes(
            card.title.toLowerCase().replace(/\s+/g, "_")
        );

    });


    if (filteredCards.length === 0) {

        const message = document.createElement("div");

        message.className = "card";

        const heading = document.createElement("h3");

        heading.textContent = "No insights available";

        const paragraph = document.createElement("p");

        paragraph.textContent =
            "The API returned no climate insight values for " +
            stateName + ".";

        message.appendChild(heading);

        message.appendChild(paragraph);

        container.appendChild(message);

        return;
    }


    filteredCards.forEach(function(item) {

        const card = document.createElement("div");

        card.className = "card";


        const heading = document.createElement("h3");

        heading.textContent = item.title;


        const paragraph = document.createElement("p");

        paragraph.textContent = item.text;


        card.appendChild(heading);

        card.appendChild(paragraph);

        container.appendChild(card);

    });


    // Display data note separately when supplied.

    if (data.data_note) {

        const note = document.createElement("p");

        note.className = "data-note";

        note.textContent = data.data_note;

        container.appendChild(note);
    }

    console.log(
        "Climate insights rendered:",
        filteredCards.length
    );
}


/* =========================================
   19. INITIALIZE EARTHPULSE
========================================= */

async function initializeEarthPulse() {

    console.log(
        "Starting EARTHPULSE Environmental Intelligence..."
    );


    // Load India map and state boundaries first.

    await initializeIndiaMap();


    // Initialize existing features.

    initializeStateSearch();

    initializeComparison();


    // Initialize new features.

    initializeSatelliteMap();

    initializeSatelliteControls();

    initializeClimateInsights();


    // Load default dashboard data.

    await loadEarthData();


    console.log(
        "EARTHPULSE initialization completed."
    );
}


/* =========================================
   20. PAGE LOAD EVENT
========================================= */

if (document.readyState === "loading") {

    document.addEventListener(
        "DOMContentLoaded",
        initializeEarthPulse
    );

} else {

    initializeEarthPulse();

}


/* =========================================
   END OF EARTHPULSE SCRIPT
========================================= */
