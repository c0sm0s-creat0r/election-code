from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS


app = Flask(__name__)
CORS(app)

@app.route('/api/data', methods=['GET'])
def get_data():
    return jsonify({"message": "Hello from Python!"})

@app.route('/')
def serve():
    return send_from_directory('react-frontend/build', 'index.html')

@app.route("/api/message", methods=["POST"])
def message():
    data = request.json
    msg = data.get("message", "")
    print(f"INCOMING TRANSMISSION: {msg}")
    return jsonify({"reply": f"Flask received: {msg}"})

if __name__ == "__main__":
    app.run(debug=True)
    
    