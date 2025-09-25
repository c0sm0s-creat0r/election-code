import React, { useEffect, useState } from "react";
import axios from "axios";
// const API = "http://127.0.0.1:4500/api";
// const API = import.meta.env.VITE_API_BASE || "https://api.dalyell.com.au/api";
const API = import.meta.env.VITE_API_BASE || "https://election-code.onrender.com/api";

export default function App() {
  const [elections, setElections] = useState([]);
  const [currentElection, setCurrentElection] = useState(null);
  const [ballot, setBallot] = useState([]);
  const [error, setError] = useState("");

  // Pseudo-login state
  const [name, setName] = useState("");
  const [usuId, setUsuId] = useState("");
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    axios.get(`${API}/elections`)
      .then(res => setElections(res.data))
      .catch(err => console.error("Error fetching elections:", err));
  }, []);

  const loadElection = (id) => {
    axios.get(`${API}/elections/${id}`)
      .then(res => { setCurrentElection(res.data); setBallot([]); setError(""); setLoggedIn(false); setName(""); setUsuId(""); })
      .catch(err => console.error("Error loading election:", err));
  };

  const login = () => {
    if (!currentElection) return;
    axios.post(`${API}/elections/${currentElection.id}/login`, { name, usu_id: usuId })
      .then(() => { setLoggedIn(true); setError(""); })
      .catch(err => setError(err?.response?.data?.error || "Login failed"));
  };

  const toggleRank = (cid) => {
    setBallot(prev => prev.includes(cid) ? prev.filter(x => x !== cid) : [...prev, cid]);
  };

  const submitBallot = () => {
    if (!currentElection) return;
    axios.post(`${API}/elections/${currentElection.id}/ballots`, { ballot, voter: { name, usu_id: usuId } })
      .then(() => loadElection(currentElection.id))
      .catch(err => setError(err?.response?.data?.error || "Failed to submit ballot"));
  };

  const validUsu = /^\d{7,8}$/.test(usuId);

  return (
    <div style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 900, margin: "0 auto" }}>
      <h1>Welcome voter to the DSA Elections!</h1>
      <h6>Created by Ben & funded by Charlise</h6>
      <section>
        <p>If you don't see any elections below, don't worry, when it comes time to vote we'll let you know!</p>
        <h2>Active Elections</h2>
        <ul>
          {elections.map(election => (
            <li key={election.id}>
              <button onClick={() => loadElection(election.id)} style={{ marginRight: 8 }}>Open</button>
              {election.name} (candidates: {election.candidates.length}, ballots: {election.ballots.length})
            </li>
          ))}
        </ul>
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
              {!validUsu && usuId && <p style={{ color: "crimson" }}>USU ID must be 7–8 digits.</p>}
              {error && <p style={{ color: "crimson" }}>{error}</p>}
            </div>
          ) : (
            <div>
              <div style={{ marginBottom: 12 }}>
                <strong>Logged in as:</strong> {name} (USU {usuId})
              </div>
              <h3>Rank Candidates</h3>
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