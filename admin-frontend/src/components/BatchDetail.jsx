import React, { useEffect, useState, useMemo } from "react";
import axios from "axios";

export default function BatchDetail({ api, batch, onRefreshBatch }) {
  const [token, setToken] = useState(
    localStorage.getItem(`admin_token:${batch.id}`) || ""
  );
  const [branding, setBranding] = useState(
    batch.branding || {
      title: "",
      org_name: "",
      accent_color: "#2563eb",
      logo_url: "",
    }
  );
  const [elections, setElections] = useState([]);
  const [newElectionName, setNewElectionName] = useState("");
  const [currentElection, setCurrentElection] = useState(null);
  const [candidateName, setCandidateName] = useState("");
  const [tally, setTally] = useState(null);
  const [error, setError] = useState("");

  // toggles
  const [showBranding, setShowBranding] = useState(false);

  const ax = useMemo(
    () =>
      axios.create({
        baseURL: api,
        headers: { "X-Admin-Token": token },
      }),
    [api, token]
  );

useEffect(() => {
    setBranding(batch.branding || {});
    axios
      .get(`${api}/batches/${batch.id}/elections`)
      .then(({ data }) => setElections(data || []))
      .catch(() => setError("Failed to load elections"));
  }, [api, batch]);

  const saveToken = () => {
    localStorage.setItem(`admin_token:${batch.id}`, token);
    setError("");
  };

  const saveBranding = () => {
    ax.patch(`/batches/${batch.id}/branding`, branding)
      .then(({ data }) => {
        setBranding(data.branding || branding);
        onRefreshBatch && onRefreshBatch({ ...batch, branding: data.branding });
        setShowBranding(false);
      })
      .catch((err) =>
        setError(err?.response?.data?.error || "Failed to update branding")
      );
  };

  const createElection = () => {
    ax.post(`/batches/${batch.id}/elections`, {
      name: newElectionName || "Untitled Election",
    })
      .then(({ data }) => {
        setElections([data, ...elections]);
        setNewElectionName("");
      })
      .catch((err) =>
        setError(err?.response?.data?.error || "Failed to create election")
      );
  };

  const loadElection = (id) => {
    axios
      .get(`${api}/batches/${batch.id}/elections/${id}`)
      .then(({ data }) => {
        setCurrentElection(data);
        setCandidateName("");
        setTally(null);
      })
      .catch((err) =>
        setError(err?.response?.data?.error || "Failed to load election")
      );
  };

  const addCandidate = () => {
    if (!currentElection || !candidateName) return;
    ax.post(`/batches/${batch.id}/elections/${currentElection.id}/candidates`, {
      name: candidateName,
    })
      .then(({ data }) => {
        setCurrentElection(data);
        setCandidateName("");
      })
      .catch((err) =>
        setError(err?.response?.data?.error || "Failed to add candidate")
      );
  };

  // const tallyResults = () => {
  //   if (!currentElection) return;
  //   ax.get(`/batches/${batch.id}/elections/${currentElection.id}/tally`)
  //     .then(({ data }) => alert(JSON.stringify(data, null, 2)))
  //     .catch((err) =>
  //       setError(err?.response?.data?.error || "Failed to tally")
  //     );
  // };
  const tallyResults = () => {
    if (!currentElection) return;
    ax.get(`/batches/${batch.id}/elections/${currentElection.id}/tally`)
      .then(res => setTally(res.data))
      .catch(err => setError(err?.response?.data?.error || "Failed to tally"));
  };

  const downloadElectionAttendance = () => {
    if (!currentElection) return;
    ax.get(
      `/batches/${batch.id}/elections/${currentElection.id}/attendance.csv`,
      { responseType: "blob" }
    )
      .then((res) => {
        const blob = new Blob([res.data], { type: "text/csv" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `attendance_${currentElection.id}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
      })
      .catch((err) =>
        setError(err?.response?.data?.error || "Failed to download attendance")
      );
  };

  const downloadBatchAttendance = () => {
    ax.get(`/batches/${batch.id}/attendance.csv`, { responseType: "blob" })
      .then((res) => {
        const blob = new Blob([res.data], { type: "text/csv" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = `attendance_batch_${batch.id}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
      })
      .catch((err) =>
        setError(
          err?.response?.data?.error || "Failed to download batch attendance"
        )
      );
  };

  return (
    <div>
      <header style={{ display: "flex", justifyContent: "space-between" }}>
            <h1>Election Overview — {batch.name}</h1>
            <img
              src={batch.branding.logo_url}
              alt="logo"
              width="60"
              height="60"
              loading="lazy"
            />
      </header>
      <h3>Organisation: {batch.branding.org_name}</h3>
      <div style={{ borderStyle: "dotted", textAlign: "center"}}>
        <h3>
          Custom voting url: vote.dalyell.com/{batch.slug}
        </h3>
      </div>

      <h4>
        Welcome Returning Officer! To your super secret custom admin election dashboard!!!!
      </h4>
      {/* <h5>
        <i>"You like preferential voting, we like preferential voting"</i>
      </h5> */}

      <section>
        <text><strong>&nbsp;&nbsp;&nbsp;&nbsp;Password: </strong></text>
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Enter password for election"
          />
          <button onClick={saveToken}>Enter</button>
      </section>

      <section>
        <h3>How to Use the Admin Panel</h3>
        <ol>
          <li>Input password above</li>
          <li>Scroll down to Admin Panel</li>
          <li>Create a new election by entering a name and clicking the "Create Election" button.</li>
          <li>Select an existing election from the list to manage it.</li>
          <li>Add candidates to the election by providing their names and submitting them.</li>
          <li>Once all candidates have been added, inform the voters they can now vote</li>
          <li>Remind voters to vote for all candidates</li>
          <li>When voting closes, run the tally to calculate results. My method is Instant Runoff Voting (cause Australian system yay). The system will show elimination rounds and the winner.</li>
        </ol>
        <br></br>
        <ul>
          <li>
            If a voter cannot cast a ballot, check that their USU ID is valid and that they have not already voted in the same election.
          </li>
          <li>
            Monitor attendance: each voter's name and USU ID will be recorded when they log in and cast a ballot.
          </li>
          <li>
            Download attendance: for a single election or for all elections as a CSV file for record keeping.
          </li>
          <li>Enjoy!</li>
        </ul>
        <p>
          Remember: voters can only interact with the voter side. DO NOT SHOW THIS SITE TO ANYONE BUT YOU.
        </p>
      </section>

      <h1>Admin Panel</h1>
      <section id="Admin Panel" style={{ border: "2px solid", borderRadius: 8, padding: 12, marginBottom: 16, borderStyle: "solid", padding: "1em", borderColor: batch.branding.accent_color}}>

        {/* Toggle button for Branding editor */}
        <section style={showBranding ?{ border: "1px solid #ddd", borderRadius: 8, padding: 12, marginBottom: 16} : null}>
          <button onClick={() => setShowBranding((s) => !s)}>
            {showBranding ? "Close Branding Editor" : "Edit Branding"}
          </button>

          {showBranding && (
            <section>
              <h3>Branding</h3>
              <label>
                Election Title
                <input
                  value={branding.title || ""}
                  onChange={(e) =>
                    setBranding({ ...branding, title: e.target.value })
                  }
                />
              </label>
              <label>
                Name of your Organisation
                <input
                  value={branding.org_name || ""}
                  onChange={(e) =>
                    setBranding({ ...branding, org_name: e.target.value })
                  }
                />
              </label>
              <label>
                Accent Color
                <input
                  type="color"
                  value={branding.accent_color || "#2563eb"}
                  onChange={(e) =>
                    setBranding({ ...branding, accent_color: e.target.value })
                  }
                />
              </label>
              <label>
                Logo (public url)
                <input
                  value={branding.logo_url || ""}
                  onChange={(e) =>
                    setBranding({ ...branding, logo_url: e.target.value })
                  }
                />
              </label>
              {/* FUTURE (logo upload): replace Logo URL with a file input and POST to /api/batches/<id>/logo */}
              <div>
                <button onClick={saveBranding}>Save Branding</button>
              </div>
            </section>
          )}
        </section>

        <section>
          <h3>Create Election</h3>
          <input
            value={newElectionName}
            onChange={(e) => setNewElectionName(e.target.value)}
            placeholder="Election name"
          />
          <button onClick={createElection}>Create Election</button>
        </section>

        <section>
          <h3>Existing Elections</h3>
          <ul>
            {elections.map((e) => (
              <li key={e.id}>
                <button onClick={() => loadElection(e.id)}>Manage</button>{" "}
                {e.name}
              </li>
            ))}
          </ul>
          <button onClick={downloadBatchAttendance}>
            Download Attendance of All Elections CSV
          </button>
        </section>

        {/* {currentElection && (
          <section>
            <h3>Manage Election: {currentElection.name}</h3>
            <div>
              <input
                value={candidateName}
                onChange={(e) => setCandidateName(e.target.value)}
                placeholder="Candidate name"
              />
              <button onClick={addCandidate}>Add Candidate</button>
              <button onClick={tally}>Tally</button>
              <button onClick={downloadElectionAttendance}>
                Download Election Attendance CSV
              </button>
            </div>
            <ul>
              {currentElection.candidates.map((c) => (
                <li key={c.id}>{c.name}</li>
              ))}
            </ul>
          </section>
        )} */}

        {currentElection && (
          <section style={{ border: "1px solid #eee", borderRadius: 8, padding: 12 }}>
            <h2>Managing Election: {currentElection.name}</h2>
            <div style={{ marginBottom: 12 }}>
              <input value={candidateName} onChange={e => setCandidateName(e.target.value)} placeholder="Candidate name" />
              <button onClick={addCandidate} style={{ marginLeft: 8 }}>Add Candidate</button>
              <button onClick={downloadElectionAttendance} style={{ marginLeft: 8 }}>Download Attendance CSV</button>
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
      </section>

      {error && <p>{error}</p>}
    </div>
  );
}
