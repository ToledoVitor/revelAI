import { List, X } from "@phosphor-icons/react";
import { designTokens } from "@revelai/design-system";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
} from "react";
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
import type { ReviewCapturePort } from "./verified/capture";
import type { ReviewSetupPort } from "./verified/setup";

export const reviewRoutesEnabled =
  import.meta.env.DEV || import.meta.env.MODE === "test";

const reviewSetupModulePath = "./verified/setup";
const reviewCaptureModulePath = "./verified/capture";
type ReviewSetupRouteComponentProps = Readonly<{
  port?: ReviewSetupPort;
}>;
type ReviewCaptureRouteComponentProps = Readonly<{
  port?: ReviewCapturePort;
}>;

const ReviewSetupRoute = reviewRoutesEnabled
  ? lazy(async () => {
      const reviewModule = await import(
        /* @vite-ignore */ reviewSetupModulePath
      );
      return {
        default:
          reviewModule.ReviewSetupRoute as ComponentType<ReviewSetupRouteComponentProps>,
      };
    })
  : null;

const ReviewCaptureRoute = reviewRoutesEnabled
  ? lazy(async () => {
      const reviewModule = await import(
        /* @vite-ignore */ reviewCaptureModulePath
      );
      return {
        default:
          reviewModule.ReviewCaptureRoute as ComponentType<ReviewCaptureRouteComponentProps>,
      };
    })
  : null;

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

type ShellProps = Readonly<{
  client: RevelApiClient;
  reviewCapturePort?: ReviewCapturePort;
  reviewSetupPort?: ReviewSetupPort;
}>;

function Shell({ client, reviewCapturePort, reviewSetupPort }: ShellProps) {
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
        {ReviewSetupRoute ? (
          <Route
            path="/_test/verified/setup"
            element={
              <Suspense fallback={<p role="status">Carregando orientação.</p>}>
                <ReviewSetupRoute port={reviewSetupPort} />
              </Suspense>
            }
          />
        ) : null}
        {ReviewCaptureRoute ? (
          <Route
            path="/_test/verified/capture"
            element={
              <Suspense fallback={<p role="status">Carregando captura.</p>}>
                <ReviewCaptureRoute port={reviewCapturePort} />
              </Suspense>
            }
          />
        ) : null}
        <Route path="*" element={<UnavailableShell />} />
      </Routes>
    </div>
  );
}

function UnavailableShell() {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const location = useLocation();
  const isIncompleteReviewDestination =
    location.pathname === "/_test/verified/setup" ||
    location.pathname === "/_test/verified/capture";

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
      {isIncompleteReviewDestination ? (
        <p>
          A orientação de preparação aguarda a ativação completa da captura e do
          resultado.
        </p>
      ) : null}
      <Link className="return-home" to="/">
        Voltar para Início
      </Link>
    </main>
  );
}

type AppProps = Readonly<{
  reviewCapturePort?: ReviewCapturePort;
  reviewSetupPort?: ReviewSetupPort;
}>;

export function App({ reviewCapturePort, reviewSetupPort }: AppProps = {}) {
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
        <Shell
          client={client}
          reviewCapturePort={reviewCapturePort}
          reviewSetupPort={reviewSetupPort}
        />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
