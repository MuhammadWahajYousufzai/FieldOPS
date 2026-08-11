/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.tsx", "./app/**/*.{js,jsx,ts,tsx}", "./lib/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        ink: "#17233B",
        field: "#243D74",
        gold: "#D8A629",
        paper: "#F7F8F4",
        line: "#DCE0D8",
        muted: "#697184",
        success: "#267057",
        danger: "#A53B2E",
      },
    },
  },
  plugins: [],
};
