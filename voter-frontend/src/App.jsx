import React, { useEffect, useState } from "react";
import axios from "axios";
import { useParams, Link } from "react-router-dom";


// const API = "http://127.0.0.1:4500/api";
const API = import.meta.env.VITE_API_BASE || "https://api.dalyell.com.au/api";
// const API = import.meta.env.VITE_API_BASE || "https://election-code.onrender.com/api";

// For each instance, the selected branding. lowkey i only have colour atm
function applyBranding(branding) {
  const root = document.documentElement;
  if (branding?.accent_color) root.style.setProperty("--accent", branding.accent_color);
  document.title = branding?.title || "Elections";
}

export default function App() {
  const { batchSlug } = useParams();
  const [batch, setBatch] = useState(null);
  const [elections, setElections] = useState([]);
  const [currentElection, setCurrentElection] = useState(null);
  const [ballot, setBallot] = useState([]);
  const [error, setError] = useState("");

  // Pseudo-login state
  const [name, setName] = useState("");
  const [usuId, setUsuId] = useState("");
  const [loggedIn, setLoggedIn] = useState(false);

  const validUsu = /^\d{7,8}$/.test(usuId);
  
  /*
  useEffect(() => {
    axios.get(`${API}/elections`)
      .then(res => setElections(res.data))
      .catch(err => console.error("Error fetching elections:", err));
  }, []);
  */
  // load batch by slug, then load elections for that batch
  useEffect(() => {
    axios.get(`${API}/batches/by-slug/${batchSlug}`)
      .then(({data}) => {
        setBatch(data);
        applyBranding(data.branding);
        return axios.get(`${API}/batches/${data.id}/elections`);
      })
      .then(({data}) => setElections(data))
      .catch(err => console.log("Failed to load batch or elections: " + err));
  }, [batchSlug]);

  const loadElection = (id) => {
    if (!batch) return;
    axios.get(`${API}/batches/${batch.id}/elections/${id}`)
      .then(res => { setCurrentElection(res.data); setBallot([]); setError(""); setLoggedIn(false); setName(""); setUsuId(""); })
      .catch(err => console.log("Error loading election" + err));
  };

  const login = () => {
    if (!batch || !currentElection) return;
    axios.post(`${API}/batches/${batch.id}/elections/${currentElection.id}/login`, {name, usu_id: usuId})
      .then(() => { setLoggedIn(true); setError(""); })
      .catch(err => setError(err?.response?.data?.error || "Login failed"));
  };

  const toggleRank = (cid) => {
    setBallot(prev => prev.includes(cid) ? prev.filter(x => x !== cid) : [...prev, cid]);
  };

  const submitBallot = () => {
    if (!batch || !currentElection) return;
    axios.post(`${API}/batches/${batch.id}/elections/${currentElection.id}/ballots`, {ballot, voter: {name, usu_id: usuId}})
      .then(() => loadElection(currentElection.id))
      .catch(err => setError(err?.response?.data?.error || "Failed to submit ballot"));
  };

  

  return (
    <div style={{ fontFamily: "sans-serif", paddingTop: "1rem", padding: "3rem", margin: "0 auto" }}>
      <p>
              <Link to="/">Back to main page</Link>
            </p>
      <header>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
            <h1>
              {batch?.branding?.title || "Elections"}
            </h1>
            {batch?.branding?.logo_url 
            ? <img src={batch.branding.logo_url} height="50" width="50" alt="logo" /> 
            : null}
        </div>
        <div>Election for: {batch?.branding?.org_name || ""}</div>
        
      </header>

      <h1>Welcome voter to the {batch?.branding?.title} elections!</h1>
      <h6>Created by Ben & funded by Charlise</h6>
      <section>
        <h2>How to Vote</h2>
        <ol>
          <li>Select the current election from the list below.</li>
          <li>Log in using your <strong>Name</strong> and <strong>USU ID</strong></li>
          <li>Rank candidates by ticking the boxes in your preferred order (top of your list = highest preference).</li>
          <li>PLEASE RANK <strong>ALL</strong> CANDIDATES</li>
          <li>Review your vote, then click <strong>Submit Ballot</strong>.</li>
          <li>Then we repeat for all elections :)</li>
        </ol>
        <ul>
          <li>You can vote <strong>once per election</strong>.</li>
          <li>Voting uses Instant Runoff Voting preferential voting method.</li>
        </ul>
        <p>If you don't see any elections below, don't worry, when it comes time to vote we'll let you know!</p>
      </section>
      
      <section>
        <h2>Active Elections</h2>
        <ul>
          {elections.map(election => (
            <li key={election.id}>
              <button onClick={() => loadElection(election.id)} style={{ marginRight: 8 }}>Open</button>
              {election.name} (candidates: {election.candidates.length}, ballots: {election.ballots.length})
            </li>
          ))}
        </ul>
        {error && <p style={{ color: "crimson" }}>{error}</p>}
      </section>

      {currentElection && (
        <section style={{ marginTop: 24 }}>
          <h2>Currently Voting on Election: {currentElection.name}</h2>

          {!loggedIn ? (
            <div style={{ border: "1px solid #eee", borderRadius: 8, padding: 12, marginBottom: 16 }}>
              <h3>Login to Vote</h3>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="Full name" />
                <input value={usuId} onChange={e => setUsuId(e.target.value)} placeholder="USU ID" />
                <button onClick={login} disabled={!name || !validUsu}>Continue</button>
              </div>
              {!validUsu && usuId && <p style={{ color: "crimson" }}>USU ID must be 7-8 digits.</p>}
              {error && <p style={{ color: "crimson" }}>{error}</p>}
            </div>
          ) : (
            <div>
              <div style={{ marginBottom: 12 }}>
                <strong>Logged in as:</strong> {name} (USU {usuId})
              </div>
              <h3>Rank Candidates</h3>
              <p><i>Remember to rank all candidates</i></p>
              <ul>
                {currentElection.candidates.map(c => (
                  <li key={c.id}>
                    <label>
                      <input type="checkbox" checked={ballot.includes(c.id)} onChange={() => toggleRank(c.id)} />
                      <span style={{ marginLeft: 8 }}>{c.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <div style={{ marginTop: 8 }}>
                <strong>Your ballot:</strong>
                <ol>{ballot.map(cid => {
                  const c = currentElection.candidates.find(x => x.id === cid);
                  return <li key={cid}>{c ? c.name : cid}</li>;
                })}</ol>
              </div>
              {error && <p style={{ color: "crimson" }}>{error}</p>}
              <button onClick={submitBallot} style={{ marginTop: 8 }} disabled={!ballot.length}>Submit Ballot</button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}