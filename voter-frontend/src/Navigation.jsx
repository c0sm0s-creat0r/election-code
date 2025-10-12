import React from "react";
import axios from "axios";
import { Link } from "react-router-dom";

const API = (import.meta.env.VITE_API_BASE || "https://api.dalyell.com.au/api").replace(/\/$/, ""); // POV you learn REGEX to remove extra trailing slash

export default function BatchNavigation() {
  const [batches, setBatches] = React.useState([]);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    axios.get(`${API}/batches`)
      .then(({ data }) => setBatches(data || []))
      .catch(err => console.log("Failed to load batches: " + err));
  }, []);

  return (
    <div style={{ fontFamily: "sans-serif", padding: "2rem", margin: "0 auto" }}>
      <h1>Available Elections</h1>

      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {batches.length === 0 ? (
        <p>No election batches currently active. (They will appear here otherwise)</p>
      ) : (
        <ul>
          {batches.map(batch_instance => (
            <li key={batch_instance.id}>
              <Link to={`/${batch_instance.slug}`}>
                <strong>{batch_instance.branding?.title || batch_instance.name || batch_instance.slug}</strong> — {batch_instance.branding?.org_name || "Organisation"}
              </Link>
              {batch_instance.branding?.logo_url ? (
                <div>
                  <img
                    src={batch_instance.branding.logo_url}
                    alt={`${batch_instance.branding?.org_name || "Logo"}`}
                    width="120"
                    height="auto"
                    loading="lazy"
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
