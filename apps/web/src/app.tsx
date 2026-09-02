import { List, X } from "@phosphor-icons/react";
import { designTokens } from "@revelai/design-system";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  BrowserRouter,
  Link,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { TrainingHistory } from "./history/history";
import { Home } from "./home/home";
import { createRevelApiClient } from "./lib/api/client";
import { getDeviceAthleteId } from "./lib/api/identity";

const appTheme = {
  "--warm-white": designTokens.color.warmWhite,
  "--near-black": designTokens.color.nearBlack,
  "--deep-emerald": designTokens.color.deepEmerald,
  "--muted-gray": designTokens.color.mutedGray,
  "--border-gray": designTokens.color.borderGray,
  "--display-font": designTokens.typography.display,
  "--body-font": designTokens.typography.body,
} as CSSProperties;

function Brand() {
  return (
    <Link className="brand" to="/" aria-label="RevelAI">
      Revel<span>AI</span>
    </Link>
  );
}

type RevelApiClient = ReturnType<typeof createRevelApiClient>;

function Shell({ client }: Readonly<{ client: RevelApiClient }>) {
  const [isNavigationOpen, setNavigationOpen] = useState(false);
  const navigationToggleRef = useRef<HTMLButtonElement>(null);
  const restoreNavigationToggleFocus = useRef(false);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isNavigationOpen && restoreNavigationToggleFocus.current) {
      navigationToggleRef.current?.focus();
      restoreNavigationToggleFocus.current = false;
    }
  }, [isNavigationOpen]);

  const closeNavigation = (restoreFocus = false) => {
    restoreNavigationToggleFocus.current = restoreFocus;
    setNavigationOpen(false);
  };

  const openUnavailable = (destination: string) => {
    closeNavigation();
    navigate(`/indisponivel/${destination}`);
  };

  return (
    <div className="app-shell" style={appTheme}>
      <header className="site-header">
        <Brand />
        <button
          ref={navigationToggleRef}
          className="navigation-toggle"
          type="button"
          aria-label={isNavigationOpen ? "Fechar navegação" : "Abrir navegação"}
          aria-expanded={isNavigationOpen}
          aria-controls="primary-navigation"
          onClick={() => {
            if (isNavigationOpen) {
              closeNavigation();
              return;
            }
            setNavigationOpen(true);
          }}
        >
          {isNavigationOpen ? <X weight="bold" /> : <List weight="bold" />}
        </button>
        <nav
          id="primary-navigation"
          className="primary-navigation"
          aria-label="Navegação principal"
          data-open={isNavigationOpen}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeNavigation(true);
            }
          }}
        >
          <Link
            to="/"
            aria-current={location.pathname === "/" ? "page" : undefined}
            onClick={() => closeNavigation()}
          >
            Início
          </Link>
          <Link to="/training/history" onClick={() => closeNavigation()}>
            Meus treinos
          </Link>
          <button type="button" onClick={() => openUnavailable("ranking")}>
            Ranking
          </button>
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<Home onUnavailable={openUnavailable} />} />
        <Route
          path="/training/history"
          element={<TrainingHistory client={client} />}
        />
        <Route
          path="/indisponivel/:destination"
          element={<UnavailableShell />}
        />
        <Route path="*" element={<UnavailableShell />} />
      </Routes>
    </div>
  );
}

function UnavailableShell() {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <main className="unavailable-shell" aria-labelledby="unavailable-heading">
      <p className="eyebrow">RevelAI</p>
      <h1 id="unavailable-heading" ref={headingRef} tabIndex={-1}>
        Indisponível
      </h1>
      <p role="status">Disponível após ativação do fluxo</p>
      <Link className="return-home" to="/">
        Voltar para Início
      </Link>
    </main>
  );
}

export function App() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false },
        },
      }),
  );
  const [client] = useState(() =>
    createRevelApiClient({
      baseUrl: window.location.origin,
      athleteId: getDeviceAthleteId(),
    }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Shell client={client} />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
