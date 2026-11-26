import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";
import { IS_TV } from "./api";
import { initTv } from "./tv";

if (IS_TV) initTv();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
