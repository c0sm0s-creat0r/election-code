import './App.css';
import React, { useState, useEffect } from 'react';
import axios from 'axios'


function App() {
  const [data, setData] = useState('');
  const [input, setInput] = useState("");
  const [response, setResponse] = useState("");

  useEffect(() => {
      axios.get('http://127.0.0.1:5000/api/data') // Flask
          .then(response => {
              setData(response.data.message);
          })
          .catch(err => {
              console.error('Error fetching data:', err);
          });
  }, []);

  const sendMessage = () => {
    axios.post("http://127.0.0.1:5000/api/message", { message: input })
      .then((response) => {
        setResponse(response.data.reply);
      })
      .catch((err) => {
        console.error("Error sending message:", err);
      });
  };

  return (
    <div className="App">
      <header className="App-header">
        <div>
            <h1>React with Python</h1>
            <p>--- {data} ---</p>
        </div>
        <div style={{ padding: "2rem" }}>
          <h1>Send a Message to Flask</h1>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message"
          />
          <button onClick={sendMessage}>Send</button>

          {response && (
            <p style={{ marginTop: "1rem" }}>
              <strong>Response:</strong> {response}
            </p>
          )}
        </div>
      </header>
    </div>
  );
}

export default App;
