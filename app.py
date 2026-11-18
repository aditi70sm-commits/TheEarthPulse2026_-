
from flask import Flask, render_template, jsonify, request, send_file
import requests
import pandas as pd
import numpy as np
import re
import time
import io
from datetime import date

from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock
from xml.sax.saxutils import escape

# PDF generation
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
    PageBreak,
    Flowable
)
from reportlab.graphics.shapes import Drawing
from reportlab.graphics.charts.linecharts import LineChart
from reportlab.graphics.charts.barcharts import VerticalBarChart
from reportlab.graphics import renderPDF


app = Flask(__name__)


# ==========================================
# NASA POWER API CONFIGURATION
# ==========================================

NASA_URL = "https://power.larc.nasa.gov/api/temporal/daily/point"

START_DATE = "20150101"
END_DATE = "20241231"

NASA_TIMEOUT = (15, 120)
NASA_RETRIES = 3


# ==========================================
# INDIAN STATES AND REPRESENTATIVE LOCATIONS
# ==========================================

STATE_LOCATIONS = {
    "Andhra Pradesh": (16.5062, 80.6480),
    "Arunachal Pradesh": (27.0844, 93.6053),
    "Assam": (26.1445, 91.7362),
    "Bihar": (25.5941, 85.1376),
    "Chhattisgarh": (21.2514, 81.6296),
    "Goa": (15.4909, 73.8278),
    "Gujarat": (23.0225, 72.5714),
    "Haryana": (29.0588, 76.0856),
    "Himachal Pradesh": (31.1048, 77.1734),
    "Jharkhand": (23.3441, 85.3096),
    "Karnataka": (12.9716, 77.5946),
    "Kerala": (8.5241, 76.9366),
    "Madhya Pradesh": (23.2599, 77.4126),
    "Maharashtra": (19.0760, 72.8777),
    "Manipur": (24.8170, 93.9368),
    "Meghalaya": (25.5788, 91.8933),
    "Mizoram": (23.7271, 92.7176),
    "Nagaland": (25.6751, 94.1086),
    "Odisha": (20.2961, 85.8245),
    "Punjab": (30.7333, 76.7794),
    "Rajasthan": (26.9124, 75.7873),
    "Sikkim": (27.3389, 88.6065),
    "Tamil Nadu": (13.0827, 80.2707),
    "Telangana": (17.3850, 78.4867),
    "Tripura": (23.8315, 91.2868),
    "Uttar Pradesh": (26.8467, 80.9462),
    "Uttarakhand": (30.3165, 78.0322),
    "West Bengal": (22.5726, 88.3639),

    # UNION TERRITORIES
    "Andaman and Nicobar Islands": (11.6234, 92.7265),
    "Chandigarh": (30.7333, 76.7796),
    "Dadra and Nagar Haveli and Daman and Diu": (20.3974, 72.8328),
    "Delhi": (28.6139, 77.2090),
    "Jammu and Kashmir": (34.0837, 74.7973),
    "Ladakh": (34.1526, 77.5771),
    "Lakshadweep": (10.5667, 72.6417),
    "Puducherry": (11.9416, 79.8083)
}


# ==========================================
# STATE NAME NORMALIZATION
# ==========================================

def normalize_state_name(state):
    return re.sub(
        r"[^a-z0-9]",
        "",
        str(state).casefold()
    )


STATE_LOOKUP = {
    normalize_state_name(state): state
    for state in STATE_LOCATIONS
}


STATE_ALIASES = {
    "orissa": "Odisha",
    "uttaranchal": "Uttarakhand",
    "pondicherry": "Puducherry",
    "jandk": "Jammu and Kashmir",
    "nctofdelhi": "Delhi"
}


def find_matching_state(state):
    normalized_state = normalize_state_name(state)

    matched_state = STATE_LOOKUP.get(normalized_state)

    if matched_state:
        return matched_state

    return STATE_ALIASES.get(normalized_state)


# ==========================================
# NASA POWER DATA FETCHING
# ==========================================

def fetch_nasa_data(latitude, longitude):

    params = {
        "parameters": "T2M,PRECTOTCORR",
        "community": "AG",
        "longitude": longitude,
        "latitude": latitude,
        "start": START_DATE,
        "end": END_DATE,
        "format": "JSON"
    }

    last_error = None

    for attempt in range(NASA_RETRIES):

        try:
            response = requests.get(
                NASA_URL,
                params=params,
                timeout=NASA_TIMEOUT
            )

            response.raise_for_status()

            data = response.json()

            parameters = data["properties"]["parameter"]

            temperature = parameters["T2M"]
            precipitation = parameters["PRECTOTCORR"]

            if not temperature or not precipitation:
                raise ValueError(
                    "NASA POWER returned empty temperature "
                    "or precipitation data."
                )

            df = pd.DataFrame({
                "date": pd.to_datetime(
                    list(temperature.keys()),
                    format="%Y%m%d"
                ),
                "temperature": list(temperature.values()),
                "precipitation": list(precipitation.values())
            })

            df["temperature"] = pd.to_numeric(
                df["temperature"],
                errors="coerce"
            )

            df["precipitation"] = pd.to_numeric(
                df["precipitation"],
                errors="coerce"
            )

            df.replace(-999, np.nan, inplace=True)

            df["year"] = df["date"].dt.year

            yearly = df.groupby("year").agg(
                temperature=("temperature", "mean"),
                precipitation=(
                    "precipitation",
                    lambda values: values.sum(min_count=1)
                )
            ).reset_index()

            all_years = pd.DataFrame({
                "year": range(
                    int(START_DATE[:4]),
                    int(END_DATE[:4]) + 1
                )
            })

            yearly = all_years.merge(
                yearly,
                on="year",
                how="left"
            )

            return yearly

        except requests.RequestException as error:

            last_error = error

            app.logger.warning(
                "NASA request attempt %s of %s failed: %s",
                attempt + 1,
                NASA_RETRIES,
                error
            )

            if attempt < NASA_RETRIES - 1:
                time.sleep(2 ** attempt)

        except (KeyError, ValueError, TypeError) as error:

            raise ValueError(
                f"Unable to process NASA POWER response: {error}"
            ) from error

    raise last_error


# ==========================================
# ENVIRONMENTAL TREND CALCULATION
# ==========================================

def calculate_trend(yearly, column):

    valid = yearly[["year", column]].copy()

    valid[column] = pd.to_numeric(
        valid[column],
        errors="coerce"
    )

    valid = valid.dropna()

    valid = valid[
        np.isfinite(valid[column]) &
        np.isfinite(valid["year"])
    ]

    anomalies = []

    if len(valid) >= 4:

        q1 = valid[column].quantile(0.25)
        q3 = valid[column].quantile(0.75)

        iqr = q3 - q1

        lower_limit = q1 - (1.5 * iqr)
        upper_limit = q3 + (1.5 * iqr)

        outliers = valid[
            (valid[column] < lower_limit) |
            (valid[column] > upper_limit)
        ]

        anomalies = [
            {
                "year": int(row["year"]),
                "value": round(float(row[column]), 2)
            }
            for _, row in outliers.iterrows()
        ]

    if len(valid) < 2:

        return {
            "direction": "Insufficient data",
            "change": None,
            "slope": None,
            "anomalies": anomalies,
            "start_year": None,
            "end_year": None
        }

    first_value = float(valid[column].iloc[0])
    last_value = float(valid[column].iloc[-1])

    change = last_value - first_value

    slope = np.polyfit(
        valid["year"].to_numpy(dtype=float),
        valid[column].to_numpy(dtype=float),
        1
    )[0]

    if change > 0.05:
        direction = "Increasing"
    elif change < -0.05:
        direction = "Decreasing"
    else:
        direction = "Stable"

    return {
        "direction": direction,
        "change": round(float(change), 2),
        "slope": round(float(slope), 4),
        "anomalies": anomalies,
        "start_year": int(valid["year"].iloc[0]),
        "end_year": int(valid["year"].iloc[-1])
    }

# ==========================================
# CLIMATE INSIGHTS GENERATOR
# ==========================================

def generate_climate_insights(temperature_analysis, rainfall_analysis):

    insights = []

    temp_direction = temperature_analysis.get("direction")
    temp_change = temperature_analysis.get("change")

    rain_direction = rainfall_analysis.get("direction")
    rain_change = rainfall_analysis.get("change")

    if temp_change is not None:

        if temp_direction == "Increasing":
            insights.append({
                "title": "Rising Temperature Trend",
                "message": (
                    f"Average annual temperature increased by "
                    f"{temp_change:.2f} °C between the available "
                    f"observation endpoints."
                ),
                "type": "warning"
            })

        elif temp_direction == "Decreasing":
            insights.append({
                "title": "Falling Temperature Trend",
                "message": (
                    f"Average annual temperature decreased by "
                    f"{abs(temp_change):.2f} °C between the "
                    f"available observation endpoints."
                ),
                "type": "info"
            })

        else:
            insights.append({
                "title": "Temperature Trend",
                "message": (
                    "Average annual temperature remained relatively "
                    "stable between the available observation endpoints."
                ),
                "type": "normal"
            })

    else:
        insights.append({
            "title": "Temperature Data",
            "message": "There is insufficient data to calculate a temperature trend.",
            "type": "info"
        })

    if rain_change is not None:

        if rain_direction == "Increasing":
            insights.append({
                "title": "Increasing Annual Rainfall",
                "message": (
                    f"Annual precipitation increased by "
                    f"{rain_change:.2f} mm between the available "
                    f"observation endpoints."
                ),
                "type": "info"
            })

        elif rain_direction == "Decreasing":
            insights.append({
                "title": "Decreasing Annual Rainfall",
                "message": (
                    f"Annual precipitation decreased by "
                    f"{abs(rain_change):.2f} mm between the "
                    f"available observation endpoints."
                ),
                "type": "warning"
            })

        else:
            insights.append({
                "title": "Rainfall Trend",
                "message": (
                    "Annual precipitation remained relatively stable "
                    "between the available observation endpoints."
                ),
                "type": "normal"
            })

    else:
        insights.append({
            "title": "Rainfall Data",
            "message": "There is insufficient data to calculate a rainfall trend.",
            "type": "info"
        })

    insights.append({
        "title": "Data Interpretation",
        "message": (
            "These insights describe historical observations at "
            "representative coordinates. They are not weather forecasts "
            "or official disaster warnings."
        ),
        "type": "info"
    })

    return insights
# ==========================================
# FORMAT ENVIRONMENTAL RESPONSE
# ==========================================

def create_environment_response(
    yearly,
    location,
    latitude,
    longitude
):

    def clean_values(series):
        return [
            None if pd.isna(value) else float(value)
            for value in series
        ]

    temperature_analysis = calculate_trend(
        yearly,
        "temperature"
    )

    precipitation_analysis = calculate_trend(
        yearly,
        "precipitation"
    )

    climate_insights = generate_climate_insights(
        temperature_analysis,
        precipitation_analysis
    )

    return {
        "location": location,

        "coordinates": {
            "latitude": latitude,
            "longitude": longitude
        },

        "source": "NASA POWER",

        "years": [
            int(year)
            for year in yearly["year"]
        ],

        "temperature": clean_values(
            yearly["temperature"]
        ),

        "precipitation": clean_values(
            yearly["precipitation"]
        ),

        "units": {
            "temperature": "°C",
            "precipitation": "mm/year"
        },

        "analysis": {
            "temperature": temperature_analysis,
            "precipitation": precipitation_analysis
        },

        "climate_insights": climate_insights,

        "data_note": (
            "Climate observations represent the selected "
            "location's coordinates, not a state-wide average."
        )
    }

# ==========================================
# INDIA-WIDE DASHBOARD CACHE
# ==========================================

INDIA_CACHE = {
    "data": None,
    "timestamp": 0
}

INDIA_CACHE_DURATION = 6 * 60 * 60

INDIA_CACHE_LOCK = Lock()


# ==========================================
# FETCH DATA FOR ONE STATE / UT
# ==========================================

def fetch_location_environment(state_name):

    latitude, longitude = STATE_LOCATIONS[state_name]

    yearly = fetch_nasa_data(
        latitude,
        longitude
    )

    return create_environment_response(
        yearly,
        state_name,
        latitude,
        longitude
    )


# ==========================================
# BUILD INDIA-WIDE ENVIRONMENTAL DATA
# ==========================================

def build_india_environment_data():

    results = []
    errors = []

    with ThreadPoolExecutor(max_workers=6) as executor:

        future_locations = {
            executor.submit(
                fetch_location_environment,
                state
            ): state
            for state in STATE_LOCATIONS
        }

        for future in as_completed(future_locations):

            state = future_locations[future]

            try:
                result = future.result()
                results.append(result)

            except Exception as error:

                app.logger.exception(
                    "Failed to fetch data for %s",
                    state
                )

                errors.append({
                    "location": state,
                    "error": str(error)
                })

    location_order = {
        state: index
        for index, state in enumerate(STATE_LOCATIONS)
    }

    results.sort(
        key=lambda item: location_order[item["location"]]
    )

    successful_count = len(results)
    failed_count = len(errors)
    total_count = len(STATE_LOCATIONS)

    return {
        "success": successful_count > 0,

        "status": (
            "complete"
            if failed_count == 0
            else "partial"
            if successful_count > 0
            else "failed"
        ),

        "country": "India",
        "source": "NASA POWER",

        "total_locations": total_count,
        "successful_locations": successful_count,
        "failed_locations": failed_count,

        "locations": results,
        "errors": errors,

        "years": list(
            range(
                int(START_DATE[:4]),
                int(END_DATE[:4]) + 1
            )
        ),

        "data_note": (
            "Each location represents climate observations "
            "at its representative coordinates. These are "
            "not official state-wide or national averages."
        )
    }


# ==========================================
# INDIA-WIDE ENVIRONMENTAL API
# ==========================================

@app.route("/api/india-trends")
def get_india_trends():

    force_refresh = (
        request.args.get("refresh", "").lower() == "true"
    )

    with INDIA_CACHE_LOCK:

        current_time = time.time()

        cache_is_valid = (
            INDIA_CACHE["data"] is not None
            and
            current_time - INDIA_CACHE["timestamp"]
            < INDIA_CACHE_DURATION
        )

        if cache_is_valid and not force_refresh:

            cached_response = dict(
                INDIA_CACHE["data"]
            )

            cached_response["cached"] = True

            return jsonify(cached_response)

        try:

            india_data = build_india_environment_data()

            if not india_data["success"]:

                return jsonify({
                    "error": (
                        "Unable to fetch environmental "
                        "data for any location."
                    ),
                    "details": india_data["errors"]
                }), 502

            if india_data["failed_locations"] == 0:

                INDIA_CACHE["data"] = india_data
                INDIA_CACHE["timestamp"] = time.time()

            india_data["cached"] = False

            return jsonify(india_data)

        except Exception as error:

            app.logger.exception(
                "Unable to build India-wide dashboard"
            )

            return jsonify({
                "error": (
                    "Unable to build India-wide dashboard."
                ),
                "details": str(error)
            }), 500

# ==========================================
# NASA GIBS SATELLITE MONITORING API
# ==========================================

GIBS_BASE_URL = (
    "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best"
)

SATELLITE_LAYERS = {
    "terra": {
        "name": "MODIS Terra True Color",
        "layer": "MODIS_Terra_CorrectedReflectance_TrueColor"
    },

    "aqua": {
        "name": "MODIS Aqua True Color",
        "layer": "MODIS_Aqua_CorrectedReflectance_TrueColor"
    },

    "viirs": {
        "name": "VIIRS SNPP True Color",
        "layer": "VIIRS_SNPP_CorrectedReflectance_TrueColor"
    }
}



@app.route("/api/satellite-config")
def get_satellite_config():

    selected_date = request.args.get(
        "date",
        date.today().isoformat()
    ).strip()

    selected_layer = request.args.get(
        "layer",
        "terra"
    ).strip().lower()

    # Validate date
    try:
        satellite_date = date.fromisoformat(selected_date)

    except ValueError:
        return jsonify({
            "success": False,
            "error": "Invalid date. Use YYYY-MM-DD format."
        }), 400

    if satellite_date > date.today():
        return jsonify({
            "success": False,
            "error": "Future satellite dates are not allowed."
        }), 400

    # Validate satellite layer
    if selected_layer not in SATELLITE_LAYERS:
        return jsonify({
            "success": False,
            "error": "Invalid satellite layer.",
            "available_layers": list(SATELLITE_LAYERS.keys())
        }), 400

    layer_info = SATELLITE_LAYERS[selected_layer]

    # Validate layer configuration
    if not layer_info.get("layer") or not layer_info.get("name"):
        return jsonify({
            "success": False,
            "error": "Satellite layer configuration is incomplete."
        }), 500

    tile_url = (
        f"{GIBS_BASE_URL.rstrip('/')}/"
        f"{layer_info['layer']}/"
        f"default/{satellite_date.isoformat()}/"
        "GoogleMapsCompatible_Level9/"
        "{z}/{y}/{x}.jpg"
    )

    return jsonify({
        "success": True,
        "source": "NASA GIBS",
        "date": satellite_date.isoformat(),
        "selected_layer": selected_layer,
        "layer_name": layer_info["name"],
        "tile_url": tile_url,
        "url": tile_url,
        "available_layers": SATELLITE_LAYERS,
        "attribution": "NASA Global Imagery Browse Services (GIBS)",
        "note": (
            "Satellite imagery availability depends on the selected "
            "layer and date. Imagery is not necessarily real-time."
        )
    })



# ==========================================
# CLIMATE INSIGHTS API
# ==========================================

@app.route("/api/climate-insights")
def get_climate_insights():

    state = request.args.get(
        "state",
        "Bihar"
    ).strip()

    matched_state = find_matching_state(state)

    if not matched_state:

        return jsonify({
            "error": "State not found: " + state
        }), 404

    latitude, longitude = STATE_LOCATIONS[matched_state]

    try:

        yearly = fetch_nasa_data(
            latitude,
            longitude
        )

        response = create_environment_response(
            yearly,
            matched_state,
            latitude,
            longitude
        )

        return jsonify({
            "success": True,
            "location": matched_state,
            "source": "NASA POWER",
            "climate_insights": response["climate_insights"],
            "analysis": response["analysis"],
            "data_note": response["data_note"]
        })

    except requests.RequestException as error:

        app.logger.exception(
            "Climate Insights NASA request failed for %s",
            matched_state
        )

        return jsonify({
            "error": "Unable to retrieve climate data.",
            "details": str(error)
        }), 502

    except Exception as error:

        app.logger.exception(
            "Climate Insights failed for %s",
            matched_state
        )

        return jsonify({
            "error": "Unable to generate climate insights.",
            "details": str(error)
        }), 500
# ==========================================
# HOME PAGE
# ==========================================

@app.route("/")
def home():
    return render_template("index.html")


# ==========================================
# EXISTING PATNA DASHBOARD API
# ==========================================

@app.route("/api/trends")
def get_trends():

    latitude, longitude = STATE_LOCATIONS["Bihar"]

    try:

        yearly = fetch_nasa_data(
            latitude,
            longitude
        )

        result = create_environment_response(
            yearly,
            "Patna, Bihar, India",
            latitude,
            longitude
        )

        return jsonify(result)

    except requests.RequestException as error:

        app.logger.exception(
            "Unable to connect to NASA POWER for Patna"
        )

        return jsonify({
            "error": "Unable to connect to NASA POWER.",
            "details": str(error)
        }), 502

    except (KeyError, ValueError, TypeError) as error:

        app.logger.exception(
            "Unable to process NASA data for Patna"
        )

        return jsonify({
            "error": "Unable to process NASA data.",
            "details": str(error)
        }), 500


# ==========================================
# STATE-WISE ENVIRONMENTAL API
# ==========================================

@app.route("/api/state-trends")
def get_state_trends():

    state = request.args.get(
        "state",
        ""
    ).strip()

    if not state:

        return jsonify({
            "error": "Please provide a state name."
        }), 400

    matched_state = find_matching_state(state)

    if matched_state is None:

        return jsonify({
            "error": "State not found: " + state,
            "available_states": list(
                STATE_LOCATIONS.keys()
            )
        }), 404

    latitude, longitude = STATE_LOCATIONS[matched_state]

    try:

        yearly = fetch_nasa_data(
            latitude,
            longitude
        )

        result = create_environment_response(
            yearly,
            matched_state,
            latitude,
            longitude
        )

        return jsonify(result)

    except requests.RequestException as error:

        app.logger.exception(
            "Unable to fetch NASA data for %s",
            matched_state
        )

        return jsonify({
            "error": "Unable to fetch NASA data.",
            "details": str(error)
        }), 502

    except (KeyError, ValueError, TypeError) as error:

        app.logger.exception(
            "Unable to process NASA data for %s",
            matched_state
        )

        return jsonify({
            "error": "Unable to process NASA data.",
            "details": str(error)
        }), 500


# ==========================================
# PDF CHART FLOWABLE
# ==========================================

class ChartFlowable(Flowable):

    def __init__(self, drawing):
        super().__init__()
        self.drawing = drawing
        self.width = drawing.width
        self.height = drawing.height

    def wrap(self, available_width, available_height):
        return self.width, self.height

    def draw(self):
        renderPDF.draw(
            self.drawing,
            self.canv,
            0,
            0
        )


# ==========================================
# PDF CHART HELPERS
# ==========================================

def make_line_chart(
    years,
    datasets,
    title="Temperature",
    y_axis_title="Temperature (°C)"
):

    drawing = Drawing(480, 225)

    chart = LineChart()

    chart.x = 45
    chart.y = 35
    chart.width = 410
    chart.height = 150

    chart.data = datasets

    chart.categoryAxis.categoryNames = [
        str(year) for year in years
    ]

    chart.categoryAxis.labels.fontSize = 8
    chart.categoryAxis.title = "Year"

    chart.valueAxis.labels.fontSize = 8
    chart.valueAxis.title = y_axis_title

    for index in range(len(datasets)):

        chart.lines[index].strokeWidth = 2

    if datasets:
        chart.lines[0].strokeColor = colors.HexColor("#16A085")

    if len(datasets) > 1:
        chart.lines[1].strokeColor = colors.HexColor("#3498DB")

    drawing.add(chart)

    return ChartFlowable(drawing)

def make_rainfall_chart(years, datasets):

    drawing = Drawing(480, 225)

    chart = VerticalBarChart()

    chart.x = 45
    chart.y = 35
    chart.width = 410
    chart.height = 150

    chart.data = datasets

    chart.categoryAxis.categoryNames = [
        str(year) for year in years
    ]

    chart.categoryAxis.labels.fontSize = 8
    chart.categoryAxis.title = "Year"

    chart.valueAxis.labels.fontSize = 8
    chart.valueAxis.title = "Precipitation (mm)"

    chart.valueAxis.valueMin = 0

    all_values = [
        value
        for dataset in datasets
        for value in dataset
    ]

    maximum = max(all_values) if all_values else 100

    chart.valueAxis.valueMax = max(100, maximum * 1.15)
    chart.valueAxis.valueStep = max(
        1,
        round(chart.valueAxis.valueMax / 5)
    )

    chart.bars[0].fillColor = colors.HexColor("#16A085")

    if len(datasets) > 1:
        chart.bars[1].fillColor = colors.HexColor("#3498DB")

    chart.groupSpacing = 8
    chart.barSpacing = 2

    drawing.add(chart)

    return ChartFlowable(drawing)


# ==========================================
# PDF REPORT STYLES
# ==========================================

def get_pdf_styles():

    styles = getSampleStyleSheet()

    styles.add(ParagraphStyle(
        name="ReportTitle",
        parent=styles["Title"],
        fontSize=22,
        leading=28,
        alignment=TA_CENTER,
        textColor=colors.HexColor("#123B46"),
        spaceAfter=8
    ))

    styles.add(ParagraphStyle(
        name="ReportSubtitle",
        parent=styles["Normal"],
        fontSize=10,
        leading=15,
        alignment=TA_CENTER,
        textColor=colors.HexColor("#52666C"),
        spaceAfter=18
    ))

    styles.add(ParagraphStyle(
        name="SectionHeading",
        parent=styles["Heading2"],
        fontSize=14,
        leading=19,
        textColor=colors.HexColor("#087F70"),
        spaceBefore=12,
        spaceAfter=8
    ))

    styles.add(ParagraphStyle(
        name="ReportBody",
        parent=styles["BodyText"],
        fontSize=9,
        leading=14,
        spaceAfter=7
    ))

    return styles


# ==========================================
# PDF TABLE HELPER
# ==========================================

def make_pdf_table(data, widths=None):

    table = Table(
        data,
        colWidths=widths,
        repeatRows=1
    )

    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#123B46")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#CCD6D8")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [
            colors.white,
            colors.HexColor("#EEF5F5")
        ]),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6)
    ]))

    return table


# ==========================================
# PDF REPORT DATA HELPERS
# ==========================================

def fetch_report_state(state_name):

    latitude, longitude = STATE_LOCATIONS[state_name]

    yearly = fetch_nasa_data(
        latitude,
        longitude
    )

    return create_environment_response(
        yearly,
        state_name,
        latitude,
        longitude
    )


def format_report_value(value, decimals=2):

    if value is None or pd.isna(value):
        return "N/A"

    return f"{float(value):.{decimals}f}"


def report_trend_text(analysis, unit):

    direction = analysis.get("direction", "Unknown")
    change = analysis.get("change")

    if change is None:
        return f"{direction}; insufficient observations."

    return (
        f"{direction}. Change between available endpoints: "
        f"{change:+.2f} {unit}."
    )


# ==========================================
# GENERATE CLIMATE PDF
# ==========================================

def generate_climate_pdf(report_data, comparison=False):

    buffer = io.BytesIO()

    document = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        rightMargin=18 * mm,
        leftMargin=18 * mm,
        topMargin=17 * mm,
        bottomMargin=17 * mm,
        title="EARTHPULSE Climate Report",
        author="EARTHPULSE"
    )

    styles = get_pdf_styles()
    story = []

    story.append(Paragraph(
        "EARTHPULSE",
        styles["ReportTitle"]
    ))

    story.append(Paragraph(
        "Climate Intelligence Report | Historical observations: 2015–2024",
        styles["ReportSubtitle"]
    ))

    if comparison:

        first = report_data[0]
        second = report_data[1]

        story.append(Paragraph(
            "State Comparison Report",
            styles["SectionHeading"]
        ))

        story.append(Paragraph(
            f"Comparison between <b>{escape(first['location'])}</b> "
            f"and <b>{escape(second['location'])}</b>.",
            styles["ReportBody"]
        ))

        first_years = {
            year: index
            for index, year in enumerate(first["years"])
        }

        second_years = {
            year: index
            for index, year in enumerate(second["years"])
        }

        common_years = sorted(
            set(first_years) & set(second_years)
        )

        common_years = [
            year for year in common_years
            if first["temperature"][first_years[year]] is not None
            and second["temperature"][second_years[year]] is not None
            and first["precipitation"][first_years[year]] is not None
            and second["precipitation"][second_years[year]] is not None
        ]

        if not common_years:
            raise ValueError(
                "The selected states have no common complete years "
                "for comparison charts."
            )

        first_temp = [
            first["temperature"][first_years[year]]
            for year in common_years
        ]

        second_temp = [
            second["temperature"][second_years[year]]
            for year in common_years
        ]

        first_rain = [
            first["precipitation"][first_years[year]]
            for year in common_years
        ]

        second_rain = [
            second["precipitation"][second_years[year]]
            for year in common_years
        ]

        story.append(Paragraph(
            "Temperature Comparison",
            styles["SectionHeading"]
        ))

        story.append(make_line_chart(
            common_years,
            [first_temp, second_temp],
            "Temperature",
            "Temperature (°C)"
        ))

        story.append(Spacer(1, 8))

        story.append(Paragraph(
            "Rainfall Comparison",
            styles["SectionHeading"]
        ))

        story.append(make_rainfall_chart(
            common_years,
            [first_rain, second_rain]
        ))

        story.append(Spacer(1, 12))

        comparison_table = [
            [
                "Metric",
                first["location"],
                second["location"]
            ]
        ]

        for metric, key, unit in [
            ("Temperature change", "temperature", "°C"),
            ("Rainfall change", "precipitation", "mm")
        ]:

            a = first["analysis"][key].get("change")
            b = second["analysis"][key].get("change")

            comparison_table.append([
                metric,
                format_report_value(a) + f" {unit}",
                format_report_value(b) + f" {unit}"
            ])

        story.append(Paragraph(
            "Trend Summary",
            styles["SectionHeading"]
        ))

        story.append(make_pdf_table(
            comparison_table,
            [55 * mm, 58 * mm, 58 * mm]
        ))

        for item in report_data:
            story.append(Spacer(1, 12))
            story.append(Paragraph(
                f"{escape(item['location'])} — Trend Details",
                styles["SectionHeading"]
            ))

            story.append(Paragraph(
                "Temperature: " + report_trend_text(
                    item["analysis"]["temperature"],
                    "°C"
                ),
                styles["ReportBody"]
            ))

            story.append(Paragraph(
                "Rainfall: " + report_trend_text(
                    item["analysis"]["precipitation"],
                    "mm"
                ),
                styles["ReportBody"]
            ))

    else:

        item = report_data[0]

        story.append(Paragraph(
            f"Climate Report: {escape(item['location'])}",
            styles["SectionHeading"]
        ))

        story.append(Paragraph(
            "Representative coordinates: "
            f"Latitude {item['coordinates']['latitude']}, "
            f"Longitude {item['coordinates']['longitude']}.",
            styles["ReportBody"]
        ))

        valid_temp_years = [
            (year, value)
            for year, value in zip(
                item["years"],
                item["temperature"]
            )
            if value is not None
        ]

        valid_rain_years = [
            (year, value)
            for year, value in zip(
                item["years"],
                item["precipitation"]
            )
            if value is not None
        ]

        if valid_temp_years:

            story.append(Paragraph(
                "Annual Average Temperature",
                styles["SectionHeading"]
            ))

            story.append(make_line_chart(
                [x[0] for x in valid_temp_years],
                [[x[1] for x in valid_temp_years]],
                "Temperature",
                "Temperature (°C)"
            ))

        if valid_rain_years:

            story.append(Paragraph(
                "Annual Precipitation",
                styles["SectionHeading"]
            ))

            story.append(make_rainfall_chart(
                [x[0] for x in valid_rain_years],
                [[x[1] for x in valid_rain_years]]
            ))

        story.append(Paragraph(
            "Environmental Trend Summary",
            styles["SectionHeading"]
        ))

        story.append(Paragraph(
            "Temperature: " + report_trend_text(
                item["analysis"]["temperature"],
                "°C"
            ),
            styles["ReportBody"]
        ))

        story.append(Paragraph(
            "Rainfall: " + report_trend_text(
                item["analysis"]["precipitation"],
                "mm"
            ),
            styles["ReportBody"]
        ))

    # ======================================
    # ANNUAL OBSERVATION TABLE
    # ======================================

    story.append(PageBreak())

    story.append(Paragraph(
        "Annual Observation Data",
        styles["SectionHeading"]
    ))

    if comparison:

        first = report_data[0]
        second = report_data[1]

        data_table = [[
            "Year",
            first["location"] + " Temp (°C)",
            first["location"] + " Rain (mm)",
            second["location"] + " Temp (°C)",
            second["location"] + " Rain (mm)"
        ]]

        first_indices = {
            year: index
            for index, year in enumerate(first["years"])
        }

        second_indices = {
            year: index
            for index, year in enumerate(second["years"])
        }

        for year in sorted(
            set(first_indices) & set(second_indices)
        ):

            i = first_indices[year]
            j = second_indices[year]

            data_table.append([
                str(year),
                format_report_value(first["temperature"][i]),
                format_report_value(first["precipitation"][i]),
                format_report_value(second["temperature"][j]),
                format_report_value(second["precipitation"][j])
            ])

        story.append(make_pdf_table(
            data_table,
            [
                17 * mm,
                34 * mm,
                34 * mm,
                34 * mm,
                34 * mm
            ]
        ))

    else:

        item = report_data[0]

        data_table = [[
            "Year",
            "Temperature (°C)",
            "Precipitation (mm)"
        ]]

        for year, temp, rain in zip(
            item["years"],
            item["temperature"],
            item["precipitation"]
        ):

            data_table.append([
                str(year),
                format_report_value(temp),
                format_report_value(rain)
            ])

        story.append(make_pdf_table(
            data_table,
            [35 * mm, 65 * mm, 65 * mm]
        ))

    # ======================================
    # ANOMALY INFORMATION
    # ======================================

    story.append(Spacer(1, 15))

    story.append(Paragraph(
        "Statistical Anomaly Summary",
        styles["SectionHeading"]
    ))

    anomaly_table = [[
        "Location",
        "Parameter",
        "Year",
        "Observed Value"
    ]]

    for item in report_data:

        for parameter, key in [
            ("Temperature", "temperature"),
            ("Precipitation", "precipitation")
        ]:

            anomalies = item["analysis"][key].get(
                "anomalies",
                []
            )

            for anomaly in anomalies:

                anomaly_table.append([
                    item["location"],
                    parameter,
                    str(anomaly["year"]),
                    format_report_value(anomaly["value"])
                ])

    if len(anomaly_table) == 1:

        anomaly_table.append([
            "All locations",
            "All parameters",
            "-",
            "No statistical outliers detected"
        ])

    story.append(make_pdf_table(
        anomaly_table,
        [45 * mm, 40 * mm, 25 * mm, 65 * mm]
    ))

    # ======================================
    # DATA SOURCE AND LIMITATIONS
    # ======================================

    story.append(Spacer(1, 15))

    story.append(Paragraph(
        "Data Source and Methodology",
        styles["SectionHeading"]
    ))

    story.append(Paragraph(
        "Source: NASA POWER (Prediction Of Worldwide Energy "
        "Resources). Daily T2M and PRECTOTCORR observations are "
        "aggregated into annual average temperature and annual "
        "precipitation totals for 2015–2024.",
        styles["ReportBody"]
    ))

    story.append(Paragraph(
        "Important limitation: Each state or union territory is "
        "represented by one selected coordinate. These observations "
        "must not be interpreted as official state-wide averages "
        "or national averages.",
        styles["ReportBody"]
    ))

    story.append(Paragraph(
        "Anomalies in this report are statistical outliers detected "
        "using the interquartile range (IQR) method. They are not "
        "official disaster alerts or proof of a climate event.",
        styles["ReportBody"]
    ))

    story.append(Paragraph(
        "Generated by EARTHPULSE | Earth Intelligence",
        styles["ReportSubtitle"]
    ))

    document.build(story)

    buffer.seek(0)

    return buffer


# ==========================================
# CLIMATE PDF DOWNLOAD API
# ==========================================

@app.route("/api/climate-report")
def download_climate_report():

    state = request.args.get(
        "state",
        ""
    ).strip()

    state1 = request.args.get(
        "state1",
        ""
    ).strip()

    state2 = request.args.get(
        "state2",
        ""
    ).strip()

    try:

        # TWO-STATE COMPARISON REPORT
        if state1 or state2:

            if not state1 or not state2:

                return jsonify({
                    "error": (
                        "Please provide both state1 and state2."
                    )
                }), 400

            matched1 = find_matching_state(state1)
            matched2 = find_matching_state(state2)

            if not matched1 or not matched2:

                return jsonify({
                    "error": "One or both state names are invalid."
                }), 404

            if matched1 == matched2:

                return jsonify({
                    "error": (
                        "Please select two different states."
                    )
                }), 400

            first_data = fetch_report_state(matched1)
            second_data = fetch_report_state(matched2)

            pdf = generate_climate_pdf(
                [first_data, second_data],
                comparison=True
            )

            filename = (
                f"EARTHPULSE_{matched1.replace(' ', '_')}_"
                f"vs_{matched2.replace(' ', '_')}_Report.pdf"
            )

        # SINGLE-STATE REPORT
        else:

            if not state:

                return jsonify({
                    "error": (
                        "Provide state or both state1 and state2."
                    )
                }), 400

            matched_state = find_matching_state(state)

            if not matched_state:

                return jsonify({
                    "error": "State not found: " + state
                }), 404

            state_data = fetch_report_state(matched_state)

            pdf = generate_climate_pdf(
                [state_data],
                comparison=False
            )

            filename = (
                f"EARTHPULSE_{matched_state.replace(' ', '_')}_"
                "Climate_Report.pdf"
            )

        return send_file(
            pdf,
            mimetype="application/pdf",
            as_attachment=True,
            download_name=filename
        )

    except requests.RequestException as error:

        app.logger.exception(
            "NASA request failed during PDF generation"
        )

        return jsonify({
            "error": "Unable to retrieve NASA POWER data.",
            "details": str(error)
        }), 502

    except Exception as error:

        app.logger.exception(
            "Climate PDF generation failed"
        )

        return jsonify({
            "error": "Unable to generate climate report.",
            "details": str(error)
        }), 500


# ==========================================
# RUN FLASK APPLICATION
# ==========================================

if __name__ == "__main__":

    app.run(
        debug=True,
        host="127.0.0.1",
        port=5000
    )
