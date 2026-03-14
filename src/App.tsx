import { BrowserRouter, Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import Reader from "./pages/Reader";
import SettingsPage from "./pages/SettingsPage";
import VocabPage from "./pages/VocabPage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/reader/:bookId" element={<Reader />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/vocab" element={<VocabPage />} />
      </Routes>
    </BrowserRouter>
  );
}
