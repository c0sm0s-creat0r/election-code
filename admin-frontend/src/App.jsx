import React, { useEffect, useState } from "react";
import axios from "axios";

const API = import.meta.env.VITE_API_BASE || "http://127.0.0.1:4000/api";
const ADMIN_TOKEN = import.meta.env.VITE_ADMIN_TOKEN;

const ax = axios.create({
  baseURL: API,
  headers: { "X-Admin-Token": ADMIN_TOKEN }
});

