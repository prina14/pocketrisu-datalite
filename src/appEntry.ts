import "./styles.css";
import "./styles/nodeonly-standard.css";
import "./ts/polyfill";
import "core-js/actual"
import "./ts/log-capture"
import "./ts/storage/database.svelte"
import App from "./App.svelte";
import { loadData } from "./ts/bootstrap";
import { initHotkey } from "./ts/hotkey";
import { initScrollbarAutoHide } from "./ts/gui/scrollbarAutoHide";
import { preLoadCheck } from "./preload";
import { mount, flushSync } from "svelte";

preLoadCheck()
let app = mount(App, {
    target: document.getElementById("app"),
});
loadData()
initHotkey()
initScrollbarAutoHide()
flushSync()
document.getElementById('preloading')?.remove()

export default app;
