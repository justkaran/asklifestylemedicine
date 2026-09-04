export type TeamMember = {
  name: string;
  badge?: string;
  role: string;
};

export const TEAM: TeamMember[] = [
  {
    name: "Michael Fredericson, MD",
    role: "Physical Medicine & Rehabilitation · Stanford SOM · Director, Lifestyle Medicine · Chief Medical Officer, USA Track & Field",
  },
  {
    name: "Anne Friedlander, PhD",
    role: "Exercise Science & Geroscience · Stanford SOM · NIH-funded aging research · Co-Director, Lifestyle Medicine Fellowship",
  },
  {
    name: "Jamie Zeitzer, PhD",
    role: "Sleep & Circadian Sciences · Stanford SOM · Co-Director, Center for Sleep Research · Advisor to NASA astronaut sleep protocols",
  },
  {
    name: "Allison Kluger",
    role: "Branding, PR & Communications · Stanford GSB Faculty · ABC News · MSNBC · Digital & Interactive Media",
  },
  {
    name: "Karan Dehghani",
    role: "Founder · Stanford GSB Fellow",
  },
  {
    name: "Karen Parker",
    badge: "Advisor",
    role: "Psychiatry and Behavioral Sciences · Stanford Director · Simons Foundation · Dep. of Defense · Kavli Fellow",
  },
];
