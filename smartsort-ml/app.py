"""
==============================================================================
SmartSort Edge Vision & Machine Learning Inference Microservice (app.py)
==============================================================================
A lightweight, CPU-optimized Python Flask API designed to execute computer vision
inference on camera frames captured by the smart bin's ESP32-CAM.

Core Responsibilities:
 1. Model Loading Waterfall: Dynamically attempts to load models via:
    LiteRT (ai-edge-litert) -> tflite_runtime -> TensorFlow Lite -> Keras -> Heuristic Fallback.
 2. Image Preprocessing: Implements dynamic Center-Crop algorithm to convert 4:3
    rectangular camera frames into perfect 1:1 squares (224x224) without spatial distortion.
 3. Tensor Execution: Evaluates quantized neural network weights and extracts argmax confidence.
 4. Zero-Latency Physical Actuation: Immediately returns JSON to the ESP32-CAM, then
    spawns a detached background thread to forward high-resolution telemetry to Node.js.
 5. Fill-Level Telemetry Bridge: Receives ultrasonic distance readings from ESP32,
    converts centimeters to capacity percentages (25cm bin depth), and relays to dashboard.
"""

import os
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# ── 1. Sentry APM & Crash Reporting ──────────────────────────────────────────
try:
    import sentry_sdk
    from sentry_sdk.integrations.flask import FlaskIntegration

    sentry_sdk.init(
        dsn=os.environ.get("SENTRY_DSN", "https://bda3cc28b42072d77d287827eb5782d0@o4511825282269184.ingest.de.sentry.io/4511825373626448"),
        integrations=[FlaskIntegration()],
        default_integrations=False,
        traces_sample_rate=1.0,
    )
except ImportError:
    pass

from flask import Flask, request, jsonify
try:
    import numpy as np
except ImportError:
    np = None
import io
import logging
import requests
import base64
from functools import wraps
from PIL import Image

# ── 2. Logging Configuration ──────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__)

# ── 3. Environment & Configuration ───────────────────────────────────────────
ML_API_KEY = os.environ.get('ML_API_KEY', 'smartsort-ml-secret-key-2026')
MODEL_TFLITE = os.environ.get('ML_MODEL_PATH', 'smart_bin_model.tflite')
MODEL_KERAS  = 'smart_bin_model.keras'
IMG_SIZE = (224, 224)

# 5-class labels (alphabetical ordering matching model training output neurons)
class_names = ['glass', 'metal', 'paper', 'plastic', 'rejected_waste']

interpreter = None
keras_model = None

import importlib

# ── 4. Resilient Model Loading Strategy (Waterfall) ───────────────────────────
def load_model():
    """
    Attempts to load the trained neural network using the most performant available runtime.
    Waterfall Order:
      1. Google LiteRT (ai-edge-litert): Lowest memory footprint on modern edge devices.
      2. tflite_runtime: Lightweight standalone C++ wrapper.
      3. TensorFlow Lite: Full TensorFlow package lite interpreter.
      4. Keras Model: Unquantized full float32 neural network.
      5. Heuristic Fallback: Deterministic fallback for dev environments without compiled binaries.
    """
    global interpreter, keras_model

    # 1. Try LiteRT (ai-edge-litert)
    try:
        litert_mod = importlib.import_module("ai_edge_litert.interpreter")
        if os.path.exists(MODEL_TFLITE):
            interpreter = litert_mod.Interpreter(model_path=MODEL_TFLITE)
            interpreter.allocate_tensors()
            logger.info(f"Model loaded via ai-edge-litert: {MODEL_TFLITE}")
            return
    except Exception as e:
        logger.debug(f"ai-edge-litert skipped: {e}")

    # 2. Try tflite_runtime
    try:
        tflite_mod = importlib.import_module("tflite_runtime.interpreter")
        if os.path.exists(MODEL_TFLITE):
            interpreter = tflite_mod.Interpreter(model_path=MODEL_TFLITE)
            interpreter.allocate_tensors()
            logger.info(f"Model loaded via tflite-runtime: {MODEL_TFLITE}")
            return
    except Exception as e:
        logger.debug(f"tflite-runtime skipped: {e}")

    # 3. Try TensorFlow Lite
    try:
        tf = importlib.import_module("tensorflow")
        if os.path.exists(MODEL_TFLITE):
            interpreter = tf.lite.Interpreter(model_path=MODEL_TFLITE)
            interpreter.allocate_tensors()
            logger.info(f"Model loaded via TensorFlow Lite: {MODEL_TFLITE}")
            return
    except Exception as e:
        logger.debug(f"TensorFlow Lite skipped: {e}")

    # 4. Try Keras Model
    try:
        tf = importlib.import_module("tensorflow")
        if os.path.exists(MODEL_KERAS):
            keras_model = tf.keras.models.load_model(MODEL_KERAS)
            logger.info(f"Model loaded via Keras: {MODEL_KERAS}")
            return
    except Exception as e:
        logger.debug(f"Keras model skipped: {e}")

    logger.warning(
        f"No trained ML model found ({MODEL_TFLITE} or {MODEL_KERAS}). "
        "A heuristic fallback classifier will be used for API requests."
    )

load_model()

# ── 5. Authentication Decorator ───────────────────────────────────────────────
def require_api_key(f):
    """
    Guards incoming inference requests. Requires an 'Authorization: Bearer <token>'
    matching the shared ML_API_KEY secret.
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        auth_header = request.headers.get('Authorization')
        if not auth_header or not auth_header.startswith('Bearer '):
            return jsonify({'error': 'Unauthorized: Bearer token required'}), 401
        
        token = auth_header.split(' ')[1]
        if token != ML_API_KEY:
            return jsonify({'error': 'Forbidden: Invalid API key'}), 403
            
        return f(*args, **kwargs)
    return decorated

# ── 6. Image Preprocessing & Model Evaluation ──────────────────────────────────
def predict_image(img_bytes):
    """
    Preprocesses raw JPEG image bytes and runs neural network inference.
    
    Processing Steps:
     1. Decode image bytes to RGB PIL Image.
     2. Calculate Center-Crop square coordinates based on min(width, height)
        to prevent aspect ratio squishing (e.g. converting 4:3 OV2640 frames into 1:1).
     3. Bilinear resize cropped square to target tensor dimensions (224x224).
     4. Convert to float32 NumPy array with shape (1, 224, 224, 3).
        NOTE: The Sequential model architecture includes an internal
        `layers.Rescaling(1./127.5, offset=-1)` normalization layer.
        Therefore, raw [0, 255] pixel values MUST be passed directly without dividing by 255.
     5. Set tensor buffer, invoke model, and compute argmax class label and confidence percentage.
    
    Returns:
        tuple: (predicted_class_name: str, confidence_percentage: float)
    """
    if interpreter is not None and np is not None:
        img = Image.open(io.BytesIO(img_bytes)).convert('RGB')
        
        # Center-Crop algorithm: calculate shortest dimension and crop from center
        width, height = img.size
        min_dim = min(width, height)
        left = (width - min_dim) / 2
        top = (height - min_dim) / 2
        right = (width + min_dim) / 2
        bottom = (height + min_dim) / 2
        img = img.crop((left, top, right, bottom))
        
        img = img.resize(IMG_SIZE)
        img_array = np.array(img, dtype=np.float32)
        
        # Add batch dimension: (224, 224, 3) -> (1, 224, 224, 3)
        img_array = np.expand_dims(img_array, axis=0)
        input_details  = interpreter.get_input_details()
        output_details = interpreter.get_output_details()

        interpreter.set_tensor(input_details[0]['index'], img_array)
        interpreter.invoke()
        scores = interpreter.get_tensor(output_details[0]['index'])[0]
        predicted_class = class_names[np.argmax(scores)]
        confidence = float(100 * np.max(scores))
        return predicted_class, confidence

    elif keras_model is not None and np is not None:
        img = Image.open(io.BytesIO(img_bytes)).convert('RGB')
        
        # Center-Crop square
        width, height = img.size
        min_dim = min(width, height)
        left = (width - min_dim) / 2
        top = (height - min_dim) / 2
        right = (width + min_dim) / 2
        bottom = (height + min_dim) / 2
        img = img.crop((left, top, right, bottom))
        
        img = img.resize(IMG_SIZE)
        img_array = np.array(img, dtype=np.float32)
        
        img_array = np.expand_dims(img_array, axis=0)
        predictions = keras_model.predict(img_array, verbose=0)
        scores = predictions[0]
        predicted_class = class_names[np.argmax(scores)]
        confidence = float(100 * np.max(scores))
        return predicted_class, confidence

    else:
        # Development fallback: Deterministic modulo hashing on byte values
        logger.warning("No model file available. Using deterministic fallback classification.")
        img_sum = sum(img_bytes) if isinstance(img_bytes, (bytes, bytearray)) else 100
        predicted_idx = img_sum % len(class_names)
        predicted_class = class_names[predicted_idx]
        confidence = 94.5
        return predicted_class, confidence

# ── 7. HTTP API Routes ─────────────────────────────────────────────────────────

@app.route('/predict', methods=['POST'])
@require_api_key
def predict():
    """
    POST /predict
    Accepts multipart/form-data or raw image bytes from ESP32-CAM.
    Executes model inference, saves capture to disk, dispatches asynchronous
    telemetry to the Node.js backend, and returns compact JSON to the ESP32.
    """
    if 'image' in request.files:
        file = request.files['image']
        img_bytes = file.read()
    elif request.data:
        img_bytes = request.data
    else:
        return jsonify({
            'error': 'No image data provided. Send raw bytes or multipart form data with key "image".'
        }), 400

    try:
        # Run inference
        predicted_class, confidence = predict_image(img_bytes)
        logger.info(f"Prediction: {predicted_class} ({confidence:.2f}%)")

        # ── Step 1: Save image locally for verification and model retraining ────
        try:
            os.makedirs("captures", exist_ok=True)
            import time
            img_path = f"captures/capture_{int(time.time())}_{predicted_class}.jpg"
            with open(img_path, "wb") as f:
                f.write(img_bytes)
            logger.info(f"Saved captured image to {img_path}")
        except Exception as save_err:
            logger.error(f"Failed to save image locally: {save_err}")

        # ── Step 2: Asynchronous Telemetry Dispatch ─────────────────────────────
        # Physical motors cannot wait for slow cloud HTTP round-trips!
        # Dispatch telemetry to the Node.js dashboard in a detached background thread.
        try:
            telemetry_data = {
                "customBinId": "BIN-001",
                "lastSortedItem": predicted_class,
                "confidence": confidence,
                "imageBase64": base64.b64encode(img_bytes).decode('utf-8')
            }
            
            def send_telemetry(data):
                try:
                    resp = requests.post("http://127.0.0.1:5000/api/bins/telemetry", json=data, timeout=15)
                    if resp.status_code == 200:
                        logger.info("Successfully sent telemetry to dashboard")
                    else:
                        logger.warning(f"Dashboard returned {resp.status_code}: {resp.text}")
                except Exception as e:
                    logger.error(f"Failed to forward telemetry: {e}")
            
            import threading
            threading.Thread(target=send_telemetry, args=(telemetry_data,)).start()

        except Exception as forward_err:
            logger.error(f"Failed to spawn telemetry thread: {forward_err}")

        # ── Step 3: Return Compact JSON to Microcontroller ──────────────────────
        # The C++ ESP32 firmware uses lightweight string searching for '"bin":"'
        # separators=(',', ':') removes whitespace around colons to guarantee matching.
        import json
        from flask import Response
        
        compact_json = json.dumps({
            'bin': predicted_class,
            'confidence': round(confidence, 2)
        }, separators=(',', ':'))
        
        return Response(compact_json, mimetype='application/json')
    except Exception as e:
        logger.error(f"Error processing image: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/fill-levels', methods=['POST'])
def fill_levels():
    """
    POST /api/fill-levels
    Accepts distance measurements (cm) from the ESP32-CAM for all 4 compartments:
    glass_cm, metal_cm, paper_plastic_cm, rejected_waste_cm.
    Converts measurements into fill percentages based on a 25cm bin depth,
    and relays the data to the Node.js backend telemetry route.
    """
    data = request.json
    if not data:
        return jsonify({"error": "No data provided"}), 400
        
    try:
        # Standard physical compartment height: 25.0 cm
        BIN_DEPTH_CM = 25.0
        
        percentages = []
        for key in ["glass_cm", "metal_cm", "paper_plastic_cm", "rejected_waste_cm"]:
            cm = float(data.get(key, BIN_DEPTH_CM))
            # Sensor logic: Distance = 25cm -> 0% full; Distance = 0cm -> 100% full
            fill_pct = max(0, min(100, 100 * (1.0 - (cm / BIN_DEPTH_CM))))
            percentages.append(fill_pct)
            
        # Overall bin fill status represents the fullest individual compartment
        max_fill = max(percentages)
        logger.info(f"Received fill levels: {data} -> Max fill: {max_fill:.1f}%")
        
        # Forward capacity telemetry to Node.js backend
        try:
            payload = {
                "customBinId": "BIN-001",
                "fillLevel": int(max_fill),
                "fillLevelGlass": int(percentages[0]),
                "fillLevelMetal": int(percentages[1]),
                "fillLevelPaper": int(percentages[2]),
                "fillLevelRejected": int(percentages[3])
            }
            logger.info(f"Forwarding payload to dashboard: {payload}")
            resp = requests.post(
                "http://127.0.0.1:5000/api/bins/telemetry", 
                json=payload, 
                timeout=5
            )
            if resp.status_code != 200:
                logger.warning(f"Dashboard returned {resp.status_code} for fill level: {resp.text}")
        except Exception as forward_err:
            logger.error(f"Failed to forward fill level to dashboard: {forward_err}")
            
        return jsonify({"status": "success"})
    except Exception as e:
        logger.error(f"Error processing fill levels: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/', methods=['GET'])
def index():
    """GET / - Microservice health probe and active model status."""
    model_type = 'tflite' if interpreter else ('keras' if keras_model else 'none')
    return jsonify({
        "status": "running",
        "message": "Smart Bin API is active.",
        "model": model_type,
        "classes": class_names
    })

@app.route('/debug-sentry', methods=['GET'])
def debug_sentry():
    """GET /debug-sentry - Triggers a test exception to verify Sentry integration."""
    raise RuntimeError("Sentry test error from SmartSort ML Service!")

# ── 8. Server Process Execution ───────────────────────────────────────────────
if __name__ == '__main__':
    logger.info("Starting Smart Bin API server...")
    logger.info(f"Classes: {class_names}")
    
    port = int(os.environ.get("PORT", 5001))
    app.run(host='0.0.0.0', port=port, debug=False)