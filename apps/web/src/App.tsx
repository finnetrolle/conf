import { Navigate, Route, Routes } from "react-router-dom"
import { LandingPage } from "@/pages/LandingPage"
import { SessionPage } from "@/pages/SessionPage"

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/session/:sessionId" element={<SessionPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

