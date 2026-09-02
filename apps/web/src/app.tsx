import { List, X } from "@phosphor-icons/react";
import { designTokens } from "@revelai/design-system";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type CSSProperties } from "react";
import {
  BrowserRouter,
  Link,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { Home } from "./home/home";

const appTheme = {
  "--warm-white": designTokens.color.warmWhite,
  "--near-black": designTokens.color.nearBlack,
  "--deep-emerald": designTokens.color.deepEmerald,
  "--muted-gray": designTokens.color.mutedGray,
  "--border-gray": designTokens.color.borderGray,
  "--display-font": designTokens.typography.display,
  "--body-font": designTokens.typography.body,
} as CSSProperties;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
    },
  },
});

function Brand() {
  return (
    <Link className="brand" to="/" aria-label="RevelAI">
      Revel<span>AI</span>
    </Link>
  );
}

function Shell() {
  const [isNavigationOpen, setNavigationOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  const openUnavailable = (destination: string) => {
    setNavigationOpen(false);
    navigate(`/indisponivel/${destination}`);
  };

  return (
    <div className="app-shell" style={appTheme}>
      <header className="site-header">
        <Brand />
        <nav
          id="primary-navigation"
          className="primary-navigation"
          aria-label="Navegação principal"
          data-open={isNavigationOpen}
        >
          <Link
            to="/"
            aria-current={location.pathname === "/" ? "page" : undefined}
            onClick={() => setNavigationOpen(false)}
          >
            Início
          </Link>
          <button type="button" onClick={() => openUnavailable("meus-treinos")}>
            Meus treinos
          </button>
          <button type="button" onClick={() => openUnavailable("ranking")}>
            Ranking
          </button>
        </nav>
        <button
          className="navigation-toggle"
          type="button"
          aria-label={isNavigationOpen ? "Fechar navegação" : "Abrir navegação"}
          aria-expanded={isNavigationOpen}
          aria-controls="primary-navigation"
          onClick={() => setNavigationOpen((isOpen) => !isOpen)}
        >
          {isNavigationOpen ? <X weight="bold" /> : <List weight="bold" />}
        </button>
      </header>
      <Routes>
        <Route path="/" element={<Home onUnavailable={openUnavailable} />} />
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
  return (
    <main className="unavailable-shell" aria-labelledby="unavailable-heading">
      <p className="eyebrow">RevelAI</p>
      <h1 id="unavailable-heading">Indisponível</h1>
      <p role="status">Disponível após ativação do fluxo</p>
      <Link className="return-home" to="/">
        Voltar para Início
      </Link>
    </main>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
