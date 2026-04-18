import { useState, useEffect } from "react";
import { fetchHealth } from "../api";
import type { HealthResponse } from "../types";
import { navigateTo } from "../hooks/useRoute";

export function Header() {
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    fetchHealth().then(setHealth).catch(() => setHealth(null));
    const id = setInterval(() => {
      fetchHealth().then(setHealth).catch(() => setHealth(null));
    }, 10000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="header">
      <a className="header__logo" href="#/" onClick={() => navigateTo("/")}>
        cf<sup>2</sup>
      </a>
      <span className="header__title">Cerefox Code Factory</span>
      <span className="header__status">
        {health ? (
          <>
            <span className="status-dot status-dot--ok" />
            v{health.version}
          </>
        ) : (
          <>
            <span className="status-dot status-dot--error" />
            disconnected
          </>
        )}
      </span>
    </header>
  );
}
