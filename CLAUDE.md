# election-code

Flask backend + admin React frontend + voter React frontend.

- Backend runs on `localhost:5000` (`backend/app.py`).
- Admin frontend uses token-based auth; voter frontend is the public ballot interface.
- Vote counting is instant-runoff (IRV).
- Deployed to Render (backend) and Vercel (voter frontend).
