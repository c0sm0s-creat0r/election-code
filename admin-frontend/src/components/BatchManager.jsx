import React from "react";
import axios from "axios";
import { Link } from "react-router-dom";

export default function BatchManager({ api, batches, onCreated }) {
  const [showCreate, setShowCreate] = React.useState(false);
  const [form, setForm] = React.useState({
    name: "",
    slug: "",
    admin_token: "",
    branding: {
      title: "",
      org_name: "",
      accent_color: "#2563eb",
      logo_url: "", // PUBLIC URL for now; FUTURE: replace with file upload to backend
    },
  });
  const [error, setError] = React.useState("");

  const createBatch = () => {
    setError("");
    axios
      .post(`${api}/batches`, form)
      .then(() => {
        setForm({
          name: "",
          slug: "",
          admin_token: "",
          branding: {
            title: "",
            org_name: "",
            accent_color: "#2563eb",
            logo_url: "",
          },
        });
        onCreated && onCreated();
        setShowCreate(false);
      })
      .catch((err) =>
        setError(err?.response?.data?.error || "Failed to create batch")
      );
  };

  return (
    <div>
      <h4>
        Welcome Returning Officer! To your super secret custom admin election dashboard!!!!
      </h4>
      <h5>
        <i>"You like preferential voting, we like preferential voting"</i>
      </h5>

      <section>
        <h3>How to Use the Admin Panel</h3>
        <ol>
          <li>
            Create a new Election Overview for your AGM below by clicking "Create Election Overview" and inputting details.{" "}
            <strong>Make sure to write down password!</strong>
          </li>
          <li>
            Select the Election Overview from the list to manage it, this will take you to a new page
          </li>
          <li>Handle all election controls from that new page.</li>
        </ol>
        <p>
          Remember: voters can only interact with the voter side. DO NOT SHOW THIS SITE TO ANYONE BUT YOU.
        </p>
      </section>

      <h3>Create Election Overview Here:</h3>

      {showCreate ? (
        <button onClick={() => setShowCreate((s) => !s)}>
          "Create Election"
        </button>
      ) : null}

      {showCreate && (
        <div>
          <h3>Create Election Overview</h3>
          <div>
            <label>
              Name of Event
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="i.e. SciSOC AGM 2025"
              />
            </label>
          </div>
          <div>
            <label>
              Custom URL
              <input
                value={form.slug}
                onChange={(e) => setForm({ ...form, slug: e.target.value })}
                placeholder="(optional) i.e. scisoc-2025"
              />
            </label>
          </div>
          <div>
            <label>
              Admin Password
              <input
                value={form.admin_token}
                onChange={(e) =>
                  setForm({ ...form, admin_token: e.target.value })
                }
                placeholder="Password (DO NOT FORGET)"
              />
            </label>
          </div>
          <fieldset>
            <legend>Branding</legend>
            <label>
              Election Title
              <input
                value={form.branding.title}
                onChange={(e) =>
                  setForm({
                    ...form,
                    branding: { ...form.branding, title: e.target.value },
                  })
                }
              />
            </label>
            <label>
              Name of Your Organisation
              <input
                value={form.branding.org_name}
                onChange={(e) =>
                  setForm({
                    ...form,
                    branding: { ...form.branding, org_name: e.target.value },
                  })
                }
              />
            </label>
            <label>
              Accent Color
              <input
                type="color"
                value={form.branding.accent_color}
                onChange={(e) =>
                  setForm({
                    ...form,
                    branding: {
                      ...form.branding,
                      accent_color: e.target.value,
                    },
                  })
                }
              />
            </label>
            <label>
              Logo (public url)
              <input
                value={form.branding.logo_url}
                onChange={(e) =>
                  setForm({
                    ...form,
                    branding: { ...form.branding, logo_url: e.target.value },
                  })
                }
              />
            </label>
            {/* FUTURE (logo upload): replace Logo URL with a file input and POST to /api/batches/<id>/logo */}
          </fieldset>
          <div>
            <button
              onClick={createBatch}
              disabled={!form.name || !form.admin_token}
            >
              Create
            </button>
            {error && <p>{error}</p>}
          </div>
        </div>
      )}

      <div>
        <h3>Existing</h3>
        {!batches || batches.length === 0 ? (
          <p>No batches yet.</p>
        ) : (
          <ul>
            {batches.map((b) => (
              <li key={b.id}>
                <Link to={`/batch/${b.slug}`}>Open</Link>
                {" — "}
                <strong>{b.branding?.title || b.name || b.slug}</strong>
                {" — "}
                {b.branding?.org_name || "Organisation"}
                {b.branding?.logo_url ? (
                  <>
                    {" — "}
                    <img
                      src={b.branding.logo_url}
                      alt="logo"
                      width="60"
                      height="60"
                      loading="lazy"
                    />
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
