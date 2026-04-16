SWIFT BLADE HAIR — WEBSITE GUIDE
=================================
Plain-English instructions for Felix (or anyone helping him).

---

WHAT'S IN THIS FOLDER
----------------------
  index.html   — The website. This is the whole site in one file.
  style.css    — All the colors, fonts, and layout.
  README.txt   — This file.

You can open index.html in any browser right now to preview the site.
Double-click it or drag it into Chrome, Firefox, or Safari.

---

HOW TO EDIT THE SITE
---------------------
Open index.html in any text editor:
  - Windows: Notepad, or right-click → "Open with" → Notepad
  - Mac: TextEdit, or right-click → "Open with" → TextEdit
  - Better option (free): Download VS Code from code.visualstudio.com

Things you'll probably want to change:

  YOUR PHONE NUMBER
    Search for: (952) 917-9269
    Replace with your current number.
    (It appears in 2 places.)

  YOUR ADDRESS
    Search for: 2721 E Franklin Ave
    Update it if you ever move.

  YOUR HOURS
    Look for this section:
      Thursday – Sunday   11am – 6pm
      Monday – Wednesday  Closed
    Change the days/times as needed.

  THE BOOKING LINK
    Search for: swiftbladehair.com/s/appointments
    Replace with your current booking URL.
    (It appears in 4 places.)

  THE TAGLINE
    Find: "Sharp cuts. Real vibes. Minneapolis made."
    Change it to whatever feels right.

  ABOUT TEXT
    Find: "Felix Esuna has been crafting cuts..."
    Rewrite it in your own words.

  SERVICES
    Look for the <ol class="services-grid"> section.
    Each service looks like this:
      <li class="service-item ...">
        <span class="service-num">I</span>
        <span class="service-name">Balayage</span>
      </li>
    Add, remove, or rename services here.
    Update the roman numerals (I, II, III...) to stay in order.

---

HOW TO ADD YOUR OWN PHOTO
--------------------------
Right now the About section has a placeholder box.
To replace it with a real photo:

1. Put your photo in the same folder as index.html.
   Name it something simple like: salon.jpg

2. Open index.html and find this block:
     <div class="about-photo" ...>
       <div class="photo-inner">
         ...
       </div>
     </div>

3. Replace that entire block with:
     <img src="salon.jpg" alt="Inside the Swift Blade Hair salon" class="about-photo">

4. Save and refresh the browser.

Tips for photos:
  - Portrait orientation (taller than wide) looks best in that spot.
  - A photo of the salon space, your chair, or you working is perfect.
  - Use the photo at its original resolution — the browser will scale it.

---

HOW TO HOST THE SITE (FREE, NO MONTHLY FEE)
--------------------------------------------
Netlify Drop is the easiest option. No account required for the first upload.

  1. Go to: netlify.com/drop
  2. Drag your entire "swiftbladefelix-site" folder onto the page.
  3. Netlify gives you a random URL like: magical-fern-a3b2.netlify.app
     Your site is live instantly.

To connect your own domain (swiftbladefelix.com or swiftbladehair.com):
  1. Create a free Netlify account.
  2. Re-upload the folder to your account (site stays the same).
  3. In Netlify → Site Settings → Domain Management → Add custom domain.
  4. Follow Netlify's steps to update your domain's DNS nameservers.
     (Your domain registrar — GoDaddy, Namecheap, Google Domains, etc. —
      is where you change nameservers. Netlify will tell you exactly what to set.)

Total monthly cost: $0 (Netlify free tier is plenty for a portfolio site).

---

HOW TO MOVE FROM SQUARESPACE TO THIS SITE
------------------------------------------
If your current site is on Squarespace (squarespace.com), here's how to switch:

  1. Host the new site on Netlify first (steps above).
     Make sure everything looks right on the Netlify URL.

  2. Log into Netlify → your site → Domain settings → Add your domain.
     Netlify will give you nameserver addresses (like:
       dns1.p01.nsone.net
       dns2.p01.nsone.net )

  3. Log into wherever you registered your domain (GoDaddy, Namecheap, etc.)
     Find "Nameservers" or "DNS" settings.
     Replace the current Squarespace nameservers with the Netlify ones.

  4. DNS changes take 15 minutes to 24 hours to fully propagate.
     Once it's done, your domain points to the new site.

  5. THEN cancel Squarespace.
     Do not cancel Squarespace first — do it after the new site is live
     on your domain, so there's no gap.

---

HOW TO EMBED YOUR INSTAGRAM FEED
---------------------------------
The site already links to your Instagram page.
If you want to show actual photos from your feed, use a free widget:

  Option 1: Behold (behold.so)
    - Free tier shows 6 posts.
    - Connect your Instagram, get a <script> embed code.
    - Paste the embed code just before the </section> tag in the
      "Follow" section of index.html.

  Option 2: SnapWidget (snapwidget.com)
    - Similar process, free tier available.

  Option 3: Just link to Instagram (already done)
    - The @swiftbladefelix link in the Follow section is enough
      for most visitors. Instagram is where people will go anyway.

---

COLORS (in case you want to change them)
-----------------------------------------
Open style.css and look for the :root block near the top.

  --bg:          #0c0b09   (near-black background)
  --gold:        #C9A026   (the gold accent — buttons, highlights)
  --cream:       #F2EDE4   (main text color)
  --muted:       #6b6358   (secondary/faint text)

To change a color: replace the hex code (the # followed by 6 letters/numbers).
You can find free hex color pickers at: htmlcolorcodes.com

---

FONTS
-----
The site uses three Google Fonts (loaded automatically, no download needed):

  Cormorant SC   — The big display font (headings, logo)
  Cormorant      — Italic serif (tagline, about lead text)
  Instrument Sans — Clean body font (navigation, labels, body copy)

To change fonts, search Google Fonts (fonts.google.com), pick a font,
copy its <link> tag, and replace the one in the <head> of index.html.
Then update the font names in the :root block of style.css.

---

QUESTIONS?
----------
If you get stuck, any web developer can look at these two files and
understand exactly what's going on. The code is standard HTML and CSS —
no frameworks, no build tools, no mysteries.

Good luck, Felix.
Swift Blade. ⚔
