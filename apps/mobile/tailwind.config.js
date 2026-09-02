/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.tsx", "./app/**/*.{js,jsx,ts,tsx}", "./lib/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        ink: "#2D2729",
        field: "#CB183D",
        sky: "#EE96AC",
        gold: "#EDB35E",
        paper: "#F6F1ED",
        line: "#E9DFDA",
        muted: "#75686B",
        success: "#248564",
        danger: "#AA342C",
      },
    },
  },
  plugins: [],
};
