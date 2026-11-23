import express from "express";
import { createApp } from "./server/app.js";
import { loadConfig } from "./server/config.js";

const app = express();
app.use(createApp(loadConfig()));

export default app;
