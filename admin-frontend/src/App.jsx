import React from "react";
import axios from "axios";
import BatchManager from "./components/BatchManager";

const API = (
  import.meta.env.VITE_API_BASE || "https://api.dalyell.com.au/api"
).replace(/\/+$/, "");

export default function Home() {
  const [batches, setBatches] = React.useState([]);
  const [error, setError] = React.useState("");
  const [status, setStatus] = React.useState("checking...");

  const reloadBatches = React.useCallback(() => {
    axios
      .get(`${API}/batches`)
      .then(({ data }) => setBatches(data || []))
      .catch(() => setError("Failed to load batches"));
  }, []);

  React.useEffect(() => {
    reloadBatches();
  }, [reloadBatches]);
  
  React.useEffect(() => {
    axios.get(`${API}/health`)
      .then(() => setStatus("✅ Backend active"))
      .catch(() => setStatus("❌ Backend offline"));
  }, []);

  return (
    <div style={{ fontFamily: "sans-serif", padding: "2rem", margin: "0 auto" }} >
      <header style={{ display: "flex", justifyContent: "space-between" }}>
            <h1>Society Election Tool - by Dalyell</h1>
            <div style={{ fontWeight: "bold", marginBottom: "8px" }}>
              {status}
            </div>
      </header>
      
      <BatchManager api={API} batches={batches} onCreated={reloadBatches} />
      {/* {error && <p>{error}</p>} */}
    </div>
  );
}
