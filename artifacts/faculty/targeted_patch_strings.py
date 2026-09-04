import re

with open("src/App.tsx", "r") as f:
    content = f.read()

# Visible strings to replace
replacements = [
    ('institution: "Palonur",', 'institution: "Stanford Lifestyle Medicine",'),
    ('ask a Palonur admin', 'ask a Stanford admin'),
    ('Every steward is admitted by Palonur.', 'Every steward is admitted by Stanford Lifestyle Medicine.'),
    ('PALONUR · FACULTY', 'STANFORD LIFESTYLE MEDICINE'),
    ('Admission by Palonur', 'Admission by Stanford Lifestyle Medicine'),
    ('What Palonur answers —', 'What we answer —'),
    ('every steward is admitted by Palonur.', 'every steward is admitted by Stanford Lifestyle Medicine.'),
    ('on Palonur. Before you apply,', 'here. Before you apply,'),
    ('real person at Palonur reviews', 'real person at Stanford Lifestyle Medicine reviews'),
    ('The idea behind Palonur', 'The idea behind our portal'),
    ('A member of the Palonur team', 'A member of our team'),
    ('What Palonur is', 'What this portal is'),
    ('Palonur turns the knowledge', 'Our portal turns the knowledge'),
    ('Palonur flips that:', 'We flip that:'),
    ('what makes Palonur trustworthy', 'what makes our answers trustworthy'),
    ('what Palonur is,', 'what this is,'),
    ('About Palonur', 'About this portal'),
    ('title="Palonur ·', 'title="Stanford ·'),
    ('WhyPalonurPanel', 'WhyJoinPanel'),
    ('Why Palonur', 'Why Join'),
    ('your Palonur answer surface', 'your answer surface'),
    ('paid Palonur queries', 'paid queries'),
    ('Palonur is the faucet, not the well.', 'This platform is the distribution layer, not the source.'),
    ('The heart of Palonur:', 'The heart of the portal:'),
    ('Hosted and sent by Palonur', 'Hosted and sent by the platform'),
    ('hosted + sent by Palonur', 'hosted + sent by the platform'),
    ('Palonur already works', 'Our system already works'),
    ('across all of Palonur.', 'across the platform.'),
    ('Palonur created a private first draft', 'The system created a private first draft'),
    ('Why may Palonur process', 'Why may the system process'),
    ('Palonur deletes source text', 'The system deletes source text'),
    ("Palonur's AI", "The AI"),
    ('How Palonur indexed', 'How the system indexed'),
    ('Palonur split it into', 'the system split it into'),
    ('Palonur/AI', 'AI'),
    ('Palonur · Invitation', 'Stanford Lifestyle Medicine · Invitation'),
    ('across Palonur.', 'across the platform.'),
    ('not a Palonur answer.', 'not a governed answer.'),
    ('so Palonur', 'so the system'),
    ('Your governed Palonur pillar', 'Your governed pillar'),
    ('Contact Palonur', 'Contact the Stanford team'),
    ('Contact the Palonur team', 'Contact the Stanford team'),
    ('Palonur — no action needed.', 'Stanford — no action needed.'),
    ('Palonur (20%)', 'Platform (20%)'),
    ('Palonur · {100', 'Platform · {100'),
    ('Palonur will process your share automatically each month', 'The platform will process your share automatically each month'),
    ('Ask Palonur', 'Ask Stanford'),
    ('mailto:karan@palonur.com', 'mailto:karan@stanford.edu')
]

for old, new in replacements:
    content = content.replace(old, new)

with open("src/App.tsx", "w") as f:
    f.write(content)
