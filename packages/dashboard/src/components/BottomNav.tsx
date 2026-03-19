import { useLocation, useNavigate } from "react-router-dom";

interface NavItem {
  path: string;
  label: string;
  icon: string;
  match: (pathname: string) => boolean;
}

const NAV_ITEMS: NavItem[] = [
  {
    path: "/",
    label: "Home",
    icon: "\u2302", // house
    match: (p) => p === "/" || p === "",
  },
  {
    path: "/",
    label: "Sessions",
    icon: "\u25A0", // square — points to home (session list)
    match: (p) => p.startsWith("/session"),
  },
  {
    path: "/settings",
    label: "Settings",
    icon: "\u2699", // gear
    match: (p) => p.startsWith("/setting"),
  },
];

/**
 * Bottom navigation bar for mobile (<768px).
 * Uses CSS class .bottom-nav which is hidden on desktop via media query.
 */
export function BottomNav() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <nav className="bottom-nav">
      {NAV_ITEMS.map((item) => {
        const active = item.match(location.pathname);
        return (
          <button
            key={item.label}
            className={`bottom-nav-item${active ? " active" : ""}`}
            onClick={() => navigate(item.path)}
          >
            <span className="bottom-nav-icon">{item.icon}</span>
            <span className="bottom-nav-label">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
