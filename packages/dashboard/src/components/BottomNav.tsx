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
    path: "/sessions",
    label: "Sessions",
    icon: "\u25A0", // square
    match: (p) => p.startsWith("/session"),
  },
  {
    path: "/tasks",
    label: "Tasks",
    icon: "\u2611", // checkbox
    match: (p) => p.startsWith("/task"),
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
            key={item.path}
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
