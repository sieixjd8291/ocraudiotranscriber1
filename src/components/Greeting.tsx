import React, { useState, useEffect } from "react";

export function Greeting() {
  const [currentHour, setCurrentHour] = useState<number>(() => new Date().getHours());

  useEffect(() => {
    // Determine system hour on load
    const updateHour = () => {
      const isBatterySaver = typeof window !== "undefined" && (window as any).isBatterySaverActive;
      if (isBatterySaver && document.visibilityState === "hidden") return;
      // Only trigger a re-render when the hour actually changes.
      // The greeting text/icon is identical for the whole hour, so this avoids
      // ~2880 pointless re-renders per day from the old 30s poll.
      const newHour = new Date().getHours();
      setCurrentHour((prev) => (prev === newHour ? prev : newHour));
    };
    const isBatterySaver = typeof window !== "undefined" && (window as any).isBatterySaverActive;
    // The greeting changes at most once per hour; polling every 5 min (or 10 min
    // in battery saver) is plenty — it updates within 5 min of an hour boundary.
    const interval = setInterval(updateHour, isBatterySaver ? 600000 : 300000);
    return () => clearInterval(interval);
  }, []);

  // State calculations and SVG injection
  let text = "";
  let icon: React.ReactNode = null;

  if (currentHour >= 4 && currentHour < 6) {
    // State 1: Dawn (4:00 AM – 5:59 AM)
    text = "Peaceful dawn, welcome back";
    icon = (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-4 h-4 text-amber-500 overflow-visible"
      >
        <defs>
          <clipPath id="dawn-clip">
            <rect x="0" y="0" width="24" height="15" />
          </clipPath>
        </defs>
        {/* Sun rising and scaling up */}
        <circle
          cx="12"
          cy="15"
          r="5.5"
          fill="#f59e0b"
          stroke="#f59e0b"
          strokeWidth="0.5"
          className="dawn-sun"
          clipPath="url(#dawn-clip)"
        />
        {/* Mountain ridge lines */}
        <path
          d="M2 17l4.5-4.5L11.5 17l4.5-5.5L22 17"
          stroke="#b45309"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        {/* Soft horizon dawn glow rays */}
        <path
          d="M12 3v2M5.5 5.5l1.5 1.5M18.5 5.5l-1.5 1.5"
          stroke="#f59e0b"
          strokeWidth="1.5"
          className="dawn-rays"
        />
      </svg>
    );
  } else if (currentHour >= 6 && currentHour < 12) {
    // State 2: Morning (6:00 AM – 11:59 AM)
    text = "Good morning, welcome back";
    icon = (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-4 h-4 text-yellow-500 overflow-visible"
      >
        {/* Gentle breathing sun core */}
        <circle
          cx="12"
          cy="12"
          r="5"
          fill="#eab308"
          stroke="#eab308"
          strokeWidth="0.5"
          className="morning-sun"
        />
        {/* Clockwise rotating line-rays */}
        <g className="morning-dots" stroke="#eab308" strokeWidth="1.5">
          <line x1="12" y1="5" x2="12" y2="2.5" />
          <line x1="12" y1="19" x2="12" y2="21.5" />
          <line x1="5" y1="12" x2="2.5" y2="12" />
          <line x1="19" y1="12" x2="21.5" y2="12" />
          <line x1="7.05" y1="7.05" x2="5.28" y2="5.28" />
          <line x1="16.95" y1="7.05" x2="18.72" y2="5.28" />
          <line x1="7.05" y1="16.95" x2="5.28" y2="18.72" />
          <line x1="16.95" y1="16.95" x2="18.72" y2="18.72" />
        </g>
      </svg>
    );
  } else if (currentHour >= 12 && currentHour < 17) {
    // State 3: Afternoon (12:00 PM – 4:59 PM)
    text = "Good afternoon, welcome back";
    icon = (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-4 h-4 text-orange-500 overflow-visible"
      >
        {/* High-radiance pulsing full sun core */}
        <circle
          cx="12"
          cy="12"
          r="5.5"
          fill="#f97316"
          stroke="#f97316"
          strokeWidth="0.5"
          className="afternoon-sun"
        />
        {/* Rotating rays */}
        <g className="afternoon-rays" stroke="#f97316" strokeWidth="1.8">
          <line x1="12" y1="2" x2="12" y2="4.5" />
          <line x1="12" y1="19.5" x2="12" y2="22" />
          <line x1="2" y1="12" x2="4.5" y2="12" />
          <line x1="19.5" y1="12" x2="22" y2="12" />
          <line x1="4.93" y1="4.93" x2="6.7" y2="6.7" />
          <line x1="17.3" y1="17.3" x2="19.07" y2="19.07" />
          <line x1="19.07" y1="4.93" x2="17.3" y2="6.7" />
          <line x1="6.7" y1="17.3" x2="4.93" y2="19.07" />
        </g>
      </svg>
    );
  } else if (currentHour >= 17 && currentHour < 21) {
    // State 4: Evening (5:00 PM – 8:59 PM)
    text = "Good evening, welcome back";
    icon = (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-4 h-4 text-rose-500 overflow-visible"
      >
        <defs>
          <linearGradient id="sunset-mask-grad" x1="0" y1="0" x2="0" y2="24" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="white" />
            <stop offset="62%" stopColor="white" />
            <stop offset="72%" stopColor="black" />
            <stop offset="100%" stopColor="black" />
          </linearGradient>
          <mask id="sunset-mask" maskUnits="userSpaceOnUse">
            <rect width="24" height="24" fill="url(#sunset-mask-grad)" />
          </mask>
        </defs>
        {/* Sun slowly shifting downwards behind waves */}
        <circle
          cx="12"
          cy="12.5"
          r="5.5"
          fill="#f43f5e"
          stroke="#f43f5e"
          strokeWidth="0.5"
          className="evening-sun-ball"
          mask="url(#sunset-mask)"
        />
        {/* Water wave vector lines fading in/out */}
        <g className="evening-waves-lines" stroke="#f43f5e" strokeWidth="1.5">
          <line x1="2" y1="15" x2="22" y2="15" />
          <line x1="4.5" y1="18.5" x2="19.5" y2="18.5" />
          <line x1="7.5" y1="21.5" x2="16.5" y2="21.5" />
        </g>
      </svg>
    );
  } else if (currentHour >= 21 && currentHour < 24) {
    // State 5: Night (9:00 PM – 11:59 PM)
    text = "Good night, welcome back";
    icon = (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-4 h-4 text-indigo-500 dark:text-indigo-400 overflow-visible"
      >
        {/* Swaying and rocking crescent moon */}
        <path
          d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"
          fill="#818cf8"
          stroke="#818cf8"
          strokeWidth="0.5"
          className="night-moon-crescent"
        />
        {/* Independently twinkling stars */}
        <g stroke="none" fill="#818cf8">
          <path
            d="M19 4.5l.4.4.4-.4-.4-.4z M19 4.5M20.5 4.5h-3 M19 3v3"
            stroke="#818cf8"
            strokeWidth="1"
            className="night-star-1"
          />
          <circle cx="15.5" cy="8.5" r="0.9" className="night-star-2" />
          <circle cx="9.5" cy="5.5" r="1.1" className="night-star-3" />
        </g>
      </svg>
    );
  } else {
    // State 6: Midnight (12:00 AM – 3:59 AM)
    text = "Quiet midnight, welcome back";
    icon = (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-4 h-4 text-violet-400 overflow-visible"
      >
        <g className="owl-body-group">
          {/* Owl Body */}
          <path
            d="M12 4C9 4 5 5.5 5 10v7c0 2.2 1.8 4 4 4h6c2.2 0 4-1.8 4-4v-7c0-4.5-4-6-7-6Z"
            fill="none"
            stroke="#a78bfa"
            strokeWidth="1.5"
          />
          {/* Owl Ears */}
          <path d="M5.5 5.5L7.5 7 M18.5 5.5L16.5 7" stroke="#a78bfa" strokeWidth="1.5" />
          {/* Eye slots */}
          <circle cx="9.5" cy="11.5" r="2.3" fill="none" stroke="#a78bfa" strokeWidth="1.2" />
          <circle cx="14.5" cy="11.5" r="2.3" fill="none" stroke="#a78bfa" strokeWidth="1.2" />
          {/* Pupils with smooth scaling blink animation */}
          <g className="owl-eyes-blink">
            <circle cx="9.5" cy="11.5" r="1" fill="#a78bfa" stroke="none" />
            <circle cx="14.5" cy="11.5" r="1" fill="#a78bfa" stroke="none" />
          </g>
          {/* Beak */}
          <path d="m11 14 1 1.5 1-1.5z" fill="#a78bfa" stroke="none" />
        </g>
      </svg>
    );
  }

  return (
    <div className="flex items-center gap-1.5 mt-1 text-slate-650 dark:text-slate-300 flex-shrink-0 whitespace-nowrap select-none">
      <span className="flex items-center justify-center flex-shrink-0">
        {icon}
      </span>
      <span className="text-xs sm:text-sm font-semibold tracking-wide whitespace-nowrap flex-shrink-0 text-slate-700 dark:text-slate-300">
        {text}
      </span>
    </div>
  );
}
