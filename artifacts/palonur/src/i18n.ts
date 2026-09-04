import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import enCommon from "./locales/en/common.json";
import enHome from "./locales/en/home.json";
import enAbout from "./locales/en/about.json";
import enAgents from "./locales/en/agents.json";
import enPlatforms from "./locales/en/platforms.json";
import enSubscribe from "./locales/en/subscribe.json";
import enAccount from "./locales/en/account.json";
import enNewsletter from "./locales/en/newsletter.json";
import enTopics from "./locales/en/topics.json";
import enNotfound from "./locales/en/notfound.json";

import deCommon from "./locales/de/common.json";
import deHome from "./locales/de/home.json";
import deAbout from "./locales/de/about.json";
import deAgents from "./locales/de/agents.json";
import dePlatforms from "./locales/de/platforms.json";
import deSubscribe from "./locales/de/subscribe.json";
import deAccount from "./locales/de/account.json";
import deNewsletter from "./locales/de/newsletter.json";
import deTopics from "./locales/de/topics.json";
import deNotfound from "./locales/de/notfound.json";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        common: enCommon,
        home: enHome,
        about: enAbout,
        agents: enAgents,
        platforms: enPlatforms,
        subscribe: enSubscribe,
        account: enAccount,
        newsletter: enNewsletter,
        topics: enTopics,
        notfound: enNotfound,
      },
      de: {
        common: deCommon,
        home: deHome,
        about: deAbout,
        agents: deAgents,
        platforms: dePlatforms,
        subscribe: deSubscribe,
        account: deAccount,
        newsletter: deNewsletter,
        topics: deTopics,
        notfound: deNotfound,
      },
    },
    detection: {
      // Never auto-detect from the browser navigator. German is opt-in only:
      // the user must explicitly click DE. The chosen
      // preference is saved to localStorage and read back on the next visit.
      order: ["localStorage"],
      lookupLocalStorage: "palonur_lang",
      caches: ["localStorage"],
    },
    fallbackLng: "en",
    defaultNS: "common",
    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;
