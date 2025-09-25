import React, { useEffect, useState } from "react";
import axios from "axios";

const API = import.meta.env.VITE_API_BASE || "http://127.0.0.1:4500/api";
const ADMIN_TOKEN = import.meta.env.VITE_ADMIN_TOKEN;

const ax = axios.create({
  baseURL: API,
  headers: { "X-Admin-Token": ADMIN_TOKEN }
});

export default function App() {
  const [elections, setElections] = useState([]);
  const [newElectionName, setNewElectionName] = useState("");
  const [currentElection, setCurrentElection] = useState(null);
  const [candidateName, setCandidateName] = useState("");
  const [tally, setTally] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    axios.get(`${API}/elections`)
      .then(res => setElections(res.data))
      .catch(err => console.error("Error fetching elections:", err));
  }, []);

  const createElection = () => {
    ax.post(`/elections`, { name: newElectionName || "Untitled Election" })
      .then(res => { setElections([res.data, ...elections]); setNewElectionName(""); })
      .catch(err => setError(err?.response?.data?.error || "Failed to create election"));
  };

  const loadElection = (id) => {
    axios.get(`${API}/elections/${id}`)
      .then(res => { setCurrentElection(res.data); setCandidateName(""); setTally(null); setError(""); })
      .catch(err => setError(err?.response?.data?.error || "Failed to load election"));
  };

  const addCandidate = () => {
    if (!currentElection || !candidateName) return;
    ax.post(`/elections/${currentElection.id}/candidates`, { name: candidateName })
      .then(res => { setCurrentElection(res.data); setCandidateName(""); })
      .catch(err => setError(err?.response?.data?.error || "Failed to add candidate"));
  };

  const tallyResults = () => {
    if (!currentElection) return;
    ax.get(`/elections/${currentElection.id}/tally`)
      .then(res => setTally(res.data))
      .catch(err => setError(err?.response?.data?.error || "Failed to tally"));
  };

  const downloadAttendance = () => {
    if (!currentElection) return;
    const url = `${API}/elections/${currentElection.id}/attendance.csv`;
    ax.get(url, { responseType: "blob" })
      .then(res => {
        const blob = new Blob([res.data], { type: "text/csv" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `attendance_${currentElection.id}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
      })
      .catch(err => setError(err?.response?.data?.error || "Failed to download attendance"));
  };

  return (
    <div style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: 1000, margin: "0 auto" }}>
      <h1>IRV — Admin</h1>

      <section style={{ marginBottom: 20 }}>
        <h2>Create Election</h2>
        <input value={newElectionName} onChange={e => setNewElectionName(e.target.value)} placeholder="Election name" />
        <button onClick={createElection} style={{ marginLeft: 8 }}>Create</button>
        {error && <p style={{ color: "crimson" }}>{error}</p>}
      </section>

      <section style={{ marginBottom: 20 }}>
        <h2>Existing Elections</h2>
        <ul>
          {elections.map(election => (
            <li key={election.id}>
              <button onClick={() => loadElection(election.id)} style={{ marginRight: 8 }}>Manage</button>
              {election.name} (candidates: {election.candidates.length}, ballots: {election.ballots.length}, attendees: {election.attendees.length})
            </li>
          ))}
        </ul>
      </section>

      {currentElection && (
        <section style={{ border: "1px solid #eee", borderRadius: 8, padding: 12 }}>
          <h2>Manage: {currentElection.name}</h2>
          <div style={{ marginBottom: 12 }}>
            <input value={candidateName} onChange={e => setCandidateName(e.target.value)} placeholder="Candidate name" />
            <button onClick={addCandidate} style={{ marginLeft: 8 }}>Add Candidate</button>
            <button onClick={downloadAttendance} style={{ marginLeft: 8 }}>Download Attendance CSV</button>
          </div>

          <h3>Candidates</h3>
          <ul>
            {currentElection.candidates.map(c => <li key={c.id}>{c.name}</li>)}
          </ul>

          <div style={{ marginTop: 12 }}>
            <button onClick={tallyResults}>Tally</button>
          </div>

          {tally && (
            <div style={{ marginTop: 12 }}>
              <h3>Rounds</h3>
              {tally.rounds.map((r, idx) => (
                <div key={idx} style={{ border: "1px solid #ddd", padding: 12, borderRadius: 8, marginBottom: 8 }}>
                  <strong>Round {idx + 1}</strong>
                  <div>Majority threshold: {Math.round(r.threshold * 100)}%</div>
                  <table style={{ width: "100%", marginTop: 8, borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>Candidate</th>
                        <th style={{ textAlign: "right", borderBottom: "1px solid #ddd" }}>Votes</th>
                        <th style={{ textAlign: "right", borderBottom: "1px solid #ddd" }}>%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.tally.map(row => (
                        <tr key={row.id}>
                          <td style={{ padding: "4px 0" }}>{row.name}</td>
                          <td style={{ textAlign: "right" }}>{row.votes}</td>
                          <td style={{ textAlign: "right" }}>{(row.share * 100).toFixed(1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {r.eliminated.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      Eliminated: {r.eliminated.map(e => e.name).join(", ")}
                    </div>
                  )}
                </div>
              ))}
              {tally.winner && <h3>Winner: {tally.winner.name}</h3>}
            </div>
          )}
        </section>
      )}
    </div>
  );
}