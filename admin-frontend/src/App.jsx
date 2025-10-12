import React from "react";
import axios from "axios";
import BatchManager from "./components/BatchManager";

const API = (
  import.meta.env.VITE_API_BASE || "https://api.dalyell.com.au/api"
).replace(/\/+$/, "");

export default function Home() {
  const [batches, setBatches] = React.useState([]);
  const [error, setError] = React.useState("");

  const reloadBatches = React.useCallback(() => {
    axios
      .get(`${API}/batches`)
      .then(({ data }) => setBatches(data || []))
      .catch(() => setError("Failed to load batches"));
  }, []);

  React.useEffect(() => {
    reloadBatches();
  }, [reloadBatches]);

  return (
    <div style={{ fontFamily: "sans-serif", padding: "2rem", margin: "0 auto" }} >
      <BatchManager api={API} batches={batches} onCreated={reloadBatches} />
      {error && <p>{error}</p>}
    </div>
  );
}
