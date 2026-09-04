import { useTranslation } from "react-i18next";
import { motion, useReducedMotion } from "framer-motion";
import academicImage from "@assets/generated_images/stanford_light.jpg";

const RED   = "#B3261E";
const INK   = "#0A0A0F";
const PAPER = "#FAF8F4";
const RULE  = "rgba(10,10,15,0.12)";
const MUTED = "rgba(10,10,15,0.64)";
const SERIF = "'Georgia','Times New Roman',serif";
const SANS  = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif";

export function FacultyTribute() {
  const { t } = useTranslation("home");
  const reducedMotion = useReducedMotion();

  const renderWithEm = (s: string, emStyle?: React.CSSProperties) => {
    const parts = s.split(/\{\{em\}\}(.*?)\{\{\/em\}\}/);
    if (parts.length === 1) return <>{s}</>;
    return (
      <>
        {parts[0]}
        <em style={{ fontStyle: "italic", fontFamily: SERIF, ...(emStyle ?? {}) }}>
          {parts[1]}
        </em>
        {parts[2]}
      </>
    );
  };

  const containerVars = {
    hidden: { opacity: reducedMotion ? 1 : 0 },
    visible: {
      opacity: 1,
      transition: reducedMotion
        ? { duration: 0 }
        : { staggerChildren: 0.25, delayChildren: 0.1 },
    },
  };

  const itemVars = {
    hidden: { opacity: reducedMotion ? 1 : 0, y: reducedMotion ? 0 : 24 },
    visible: {
      opacity: 1,
      y: 0,
      transition: reducedMotion
        ? { duration: 0 }
        : { duration: 0.8, ease: [0.16, 1, 0.3, 1] as [number, number, number, number] },
    },
  };

  return (
    <section 
      data-testid="section-faculty-tribute"
      style={{
        padding: "clamp(100px, 16vh, 180px) clamp(24px, 6vw, 96px)",
        background: PAPER,
        color: INK,
        borderBottom: `1px solid ${RULE}`,
        position: "relative",
      }}
    >
      <motion.div
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-15%" }}
        variants={containerVars}
        style={{
          width: "100%",
          maxWidth: 1000,
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
        }}
      >
        <motion.div variants={itemVars} style={{ 
          fontSize: 11, fontWeight: 700, letterSpacing: ".24em", 
          textTransform: "uppercase", color: RED, marginBottom: 40 
        }}>
          {t("facultyTribute.eyebrow")}
        </motion.div>

        <motion.div variants={itemVars} style={{ 
          fontFamily: SERIF, fontSize: "clamp(26px, 4vw, 44px)", 
          fontWeight: 400, lineHeight: 1.25, letterSpacing: "-0.01em",
          color: MUTED, marginBottom: 16, maxWidth: 800
        }}>
          {t("facultyTribute.line1")}
        </motion.div>

        <motion.div variants={itemVars} style={{ 
          fontFamily: SERIF, fontSize: "clamp(26px, 4vw, 44px)", 
          fontWeight: 400, lineHeight: 1.25, letterSpacing: "-0.01em",
          color: MUTED, marginBottom: 16, maxWidth: 800
        }}>
          {t("facultyTribute.line2")}
        </motion.div>

        <motion.div variants={itemVars} style={{ 
          fontFamily: SERIF, fontSize: "clamp(28px, 4.5vw, 52px)", 
          fontWeight: 500, lineHeight: 1.15, letterSpacing: "-0.015em",
          color: INK, marginBottom: 64, maxWidth: 840
        }}>
          {renderWithEm(t("facultyTribute.line3"))}
        </motion.div>

        <motion.div 
          variants={itemVars}
          style={{
            width: "100%", 
            height: "clamp(300px, 50vh, 560px)",
            marginBottom: 80,
            borderRadius: 24,
            overflow: "hidden",
            position: "relative",
            background: "rgba(10,10,15,0.03)",
            boxShadow: "inset 0 0 0 1px rgba(10,10,15,0.08)",
          }}
        >
          <img 
            src={academicImage} 
            alt="" 
            loading="lazy"
            style={{
              width: "100%", height: "100%", objectFit: "cover",
            }} 
          />
        </motion.div>

        <motion.div variants={itemVars} style={{ 
          fontFamily: SERIF, fontSize: "clamp(30px, 4.5vw, 48px)", 
          fontWeight: 500, lineHeight: 1.15, letterSpacing: "-0.015em",
          color: INK, marginBottom: 28, maxWidth: 760
        }}>
          {renderWithEm(t("facultyTribute.payoffHeadline"))}
        </motion.div>

        <motion.p variants={itemVars} style={{ 
          margin: 0,
          fontFamily: SANS, fontSize: "clamp(18px, 1.8vw, 22px)", 
          lineHeight: 1.6, color: "rgba(10,10,15,0.72)", maxWidth: 660
        }}>
          {t("facultyTribute.payoffBody")}
        </motion.p>
      </motion.div>
    </section>
  );
}
