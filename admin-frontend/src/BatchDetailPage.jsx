import React from "react";
import axios from "axios";
import { useParams, Link } from "react-router-dom";
import BatchDetail from "./components/BatchDetail";

const API = (import.meta.env.VITE_API_BASE || "https://api.dalyell.com.au/api").replace(/\/+$/, "");

export default function BatchDetailPage() {
  const { batchSlug } = useParams();
  const [batch, setBatch] = React.useState(null);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    axios.get(`${API}/batches/by-slug/${batchSlug}`)
      .then(({ data }) => setBatch(data))
      .catch(() => console.log("Failed to load batch"));
  }, [batchSlug]);

  return (
    <div
      style={{ fontFamily: "sans-serif", paddingLeft: "2rem", paddingRight: "2rem", paddingBottom: "2rem", paddingTop: "1rem",margin: "0 auto" }}
    >
      <p>
        <Link to="/">Back to main page</Link>
      </p>

      {/* {error && <p>{error}</p>} */}
      {batch ? (
        <div>
          <BatchDetail api={API} batch={batch} onRefreshBatch={setBatch} />
        </div>
      ) : (
        !error && <p>Loading…</p>
      )}
    </div>
  );
}
