/*
 * Trajets d'hiver — la page d'édition (cycloapp.ca/edition/trajets-hiver.html).
 *
 * On y dessine, ville par ville, les pistes et passerelles ENTIÈRES qui ferment
 * l'hiver (piste des Carrières, passerelle du MIL…), avec des lignes droites et
 * des courbes, puis on change leur état d'un geste : ouvert (vert), partiel
 * (jaune), fermé (rouge). L'app les montrera à tout le monde.
 *
 * LA CLÉ
 *   Le lien complet ressemble à …/trajets-hiver.html#cle=XXXX. Ce qui suit le #
 *   n'est jamais envoyé à un serveur : ni GitHub Pages ni Supabase ne le voient
 *   passer, et il ne part pas dans l'en-tête Referer. Au premier passage, la
 *   page range la clé dans ce navigateur (localStorage) et l'efface de la barre
 *   d'adresse ; « Oublier la clé » la retire. La clé accompagne chaque écriture,
 *   et c'est la BASE qui la vérifie (migration 0038 du dépôt de l'app) : rien,
 *   ici, n'est une protection.
 *
 * LE TRACÉ
 *   On pose des points à la main (le « dessin », colonne `controle`). Chaque
 *   point est une POINTE (on y repart en ligne droite) ou un point ARRONDI (la
 *   courbe y passe sans cassure). La page en tire la ligne à dessiner (colonne
 *   `points`) : entre deux pointes, un segment droit ; ailleurs, une spline de
 *   Catmull-Rom « centripète » (elle ne fait ni boucle ni pointe parasite), avec
 *   un point tous les ~6 m. C'est cette ligne, et elle seule, que l'app lira.
 *
 * Aucune bibliothèque hors Leaflet, aucune étape de compilation : ce fichier est
 * servi tel quel.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Réglages
  // ------------------------------------------------------------------
  var SUPABASE = 'https://mytcxzitmwonqsofaejb.supabase.co';
  // La clé PUBLIQUE de Supabase, la même que dans l'app et sur la page
  // d'accueil (formulaire Android) : elle ne donne aucun droit d'écriture ici.
  var ANON =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im15dGN4eml0bXdvbnFzb2ZhZWpiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxMTUxMTcsImV4cCI6MjA5ODY5MTExN30.28V3aHmAVC2NcirzBsy_A2_iogd11ioGiTIrTTyc6nU';
  var CLE_STOCKEE = 'cycloapp.trajets-hiver.cle';
  var VILLE_STOCKEE = 'cycloapp.trajets-hiver.ville';

  // Copie de lib/regions.ts (dépôt de l'app) : identifiant, nom, centre et
  // étendue affichée (en degrés).
  var VILLES = [
    { id: 'montreal', nom: 'Montréal', lat: 45.5019, lng: -73.5674, delta: 0.35 },
    { id: 'quebec', nom: 'Québec', lat: 46.8005, lng: -71.227, delta: 0.3 },
    { id: 'sherbrooke', nom: 'Sherbrooke', lat: 45.4042, lng: -71.8929, delta: 0.2 },
    { id: 'gatineau', nom: 'Gatineau', lat: 45.4765, lng: -75.7013, delta: 0.25 },
    { id: 'granby', nom: 'Granby', lat: 45.4001, lng: -72.7343, delta: 0.15 },
    { id: 'trois-rivieres', nom: 'Trois-Rivières', lat: 46.3432, lng: -72.5428, delta: 0.2 },
  ];

  // Les trois états. Les couleurs sont celles des signalements de l'app
  // (lib/reports.ts : déblayé, partiel, non déblayé).
  var ETATS = {
    ouvert: { nom: 'Ouvert', phrase: 'Ouvert', couleur: '#27ae60' },
    partiel: { nom: 'Partiel', phrase: 'Partiellement ouvert', couleur: '#f39c12' },
    ferme: { nom: 'Fermé', phrase: 'Fermé', couleur: '#c0392b' },
  };
  var ORDRE_ETATS = ['ouvert', 'partiel', 'ferme'];
  // Un état que cette page ne connaît pas (né après elle) : gris, sans planter.
  var ETAT_INCONNU = { nom: '?', phrase: 'État inconnu', couleur: '#8e8e93' };

  // Mêmes bornes que la base (0038). Les dépasser, c'est un refus du serveur.
  var MAX_CONTROLE = 300;
  var MAX_POINTS = 3000;
  var MAX_TRAJETS = 40;
  var NOM_MAX = 80;
  var NOTE_MAX = 280;
  var LONGUEUR_MIN_M = 10;
  var PAS_COURBE_M = 6; // un point tous les ~6 m dans les courbes

  function infoEtat(etat) {
    return ETATS[etat] || ETAT_INCONNU;
  }
  function villeParId(id) {
    for (var i = 0; i < VILLES.length; i++) if (VILLES[i].id === id) return VILLES[i];
    return null;
  }

  // ------------------------------------------------------------------
  // Géométrie
  // ------------------------------------------------------------------
  var RAYON_TERRE = 6371000;

  // Distance entre deux points (haversine) — la même formule que la base.
  function distanceM(a, b) {
    var rad = Math.PI / 180;
    var dLat = (b.latitude - a.latitude) * rad;
    var dLng = (b.longitude - a.longitude) * rad;
    var h =
      Math.pow(Math.sin(dLat / 2), 2) +
      Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.pow(Math.sin(dLng / 2), 2);
    return 2 * RAYON_TERRE * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function longueurM(points) {
    var total = 0;
    for (var i = 1; i < points.length; i++) total += distanceM(points[i - 1], points[i]);
    return total;
  }

  // Les courbes se calculent en MÈTRES, sur un plan local : en degrés, une
  // courbe serait écrasée (un degré de longitude ne fait que 78 km à Montréal,
  // contre 111 km pour un degré de latitude).
  function projecteur(lat0) {
    var ky = (Math.PI / 180) * RAYON_TERRE;
    var kx = ky * Math.cos((lat0 * Math.PI) / 180);
    return {
      versXY: function (p) {
        return [p.longitude * kx, p.latitude * ky];
      },
      versPoint: function (xy) {
        return { latitude: xy[1] / ky, longitude: xy[0] / kx };
      },
    };
  }

  // Un point de la spline de Catmull-Rom centripète entre p1 et p2 (u de 0 à 1),
  // p0 et p3 étant les voisins (algorithme de Barry et Goldman).
  function pointCatmullRom(p0, p1, p2, p3, u) {
    function noeud(a, b) {
      return Math.max(Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])), 1e-3);
    }
    function mix(a, b, ta, tb, t) {
      var k = (t - ta) / (tb - ta);
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
    }
    var t0 = 0;
    var t1 = t0 + noeud(p0, p1);
    var t2 = t1 + noeud(p1, p2);
    var t3 = t2 + noeud(p2, p3);
    var t = t1 + (t2 - t1) * u;
    var a1 = mix(p0, p1, t0, t1, t);
    var a2 = mix(p1, p2, t1, t2, t);
    var a3 = mix(p2, p3, t2, t3, t);
    var b1 = mix(a1, a2, t0, t2, t);
    var b2 = mix(a2, a3, t1, t3, t);
    return mix(b1, b2, t1, t2, t);
  }

  // Du dessin à la ligne. Rend { points, milieux } : la ligne à dessiner, et le
  // milieu de chaque segment (où l'on peut insérer un point).
  //   • Un point est « arrondi » s'il est marqué lisse ET qu'il a deux voisins
  //     (les deux bouts sont toujours des pointes).
  //   • En une pointe, on remplace le voisin manquant par son reflet : la
  //     tangente pointe alors droit vers le point suivant. Entre deux pointes,
  //     les quatre points sont alignés : c'est un segment droit, qu'on ne
  //     découpe pas.
  function calculerLigne(controle, pas) {
    var n = controle.length;
    if (n === 0) return { points: [], milieux: [] };
    var proj = projecteur(controle[0].latitude);
    var P = controle.map(proj.versXY);
    var sortie = [P[0]];
    var milieux = [];
    for (var i = 0; i < n - 1; i++) {
      var p1 = P[i];
      var p2 = P[i + 1];
      var corde = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      if (corde < 0.01) {
        // Deux points confondus : rien à tracer entre eux.
        milieux.push(p1);
        continue;
      }
      var arrondi1 = i > 0 && controle[i].lisse;
      var arrondi2 = i + 2 < n && controle[i + 1].lisse;
      if (!arrondi1 && !arrondi2) {
        sortie.push(p2);
        milieux.push([(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2]);
        continue;
      }
      var p0 = arrondi1 ? P[i - 1] : [2 * p1[0] - p2[0], 2 * p1[1] - p2[1]];
      var p3 = arrondi2 ? P[i + 2] : [2 * p2[0] - p1[0], 2 * p2[1] - p1[1]];
      var m = Math.min(60, Math.max(2, Math.ceil(corde / pas)));
      for (var k = 1; k <= m; k++) sortie.push(k === m ? p2 : pointCatmullRom(p0, p1, p2, p3, k / m));
      milieux.push(pointCatmullRom(p0, p1, p2, p3, 0.5));
    }
    return { points: sortie.map(proj.versPoint), milieux: milieux.map(proj.versPoint) };
  }

  // La ligne finale : on espace les points tant qu'il y en a trop pour la base.
  function ligneDuDessin(controle) {
    var pas = PAS_COURBE_M;
    var r = calculerLigne(controle, pas);
    while (r.points.length > MAX_POINTS && pas < 2000) {
      pas *= 2;
      r = calculerLigne(controle, pas);
    }
    return r;
  }

  function arrondi6(x) {
    return Math.round(x * 1e6) / 1e6;
  }
  function pointPropre(p) {
    return { latitude: arrondi6(p.latitude), longitude: arrondi6(p.longitude) };
  }

  // ------------------------------------------------------------------
  // Serveur (PostgREST de Supabase)
  // ------------------------------------------------------------------
  function appeler(chemin, corps) {
    var options = {
      method: corps === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      headers: { apikey: ANON, Authorization: 'Bearer ' + ANON },
    };
    if (corps !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(corps);
    }
    return fetch(SUPABASE + chemin, options).then(function (r) {
      return r.text().then(function (texte) {
        var j = null;
        try {
          j = texte ? JSON.parse(texte) : null;
        } catch (e) {
          j = null;
        }
        if (!r.ok) {
          var erreur = new Error((j && j.message) || 'HTTP ' + r.status);
          erreur.code = j && j.code;
          erreur.status = r.status;
          throw erreur;
        }
        return j;
      });
    });
  }

  // `source` (migration 0040, appliquée le 2026-11-12) : sans elle en base, la
  // lecture échouerait (42703).
  var COLONNES = 'id,region_id,nom,etat,note,controle,points,distance_m,etat_depuis,modifie_le,source';
  var api = {
    verifierCle: function (cle) {
      return appeler('/rest/v1/rpc/trajets_hiver_verifier_cle', { p_cle: cle });
    },
    lister: function (ville) {
      return appeler(
        '/rest/v1/trajets_hiver?select=' + COLONNES + '&region_id=eq.' + encodeURIComponent(ville) + '&order=nom.asc'
      );
    },
    enregistrer: function (t) {
      return appeler('/rest/v1/rpc/trajets_hiver_enregistrer', {
        p_cle: S.cle,
        p_id: t.id || null,
        p_region_id: t.region_id,
        p_nom: t.nom,
        p_etat: t.etat,
        p_note: t.note,
        p_controle: t.controle,
        p_points: t.points,
      });
    },
    changerEtat: function (id, etat) {
      return appeler('/rest/v1/rpc/trajets_hiver_changer_etat', { p_cle: S.cle, p_id: id, p_etat: etat });
    },
    supprimer: function (id) {
      return appeler('/rest/v1/rpc/trajets_hiver_supprimer', { p_cle: S.cle, p_id: id });
    },
  };

  // Les codes de la 0038, en français de tous les jours.
  function messageErreur(e) {
    switch (e && e.code) {
      case 'P0007':
        return 'Clé refusée : ' + (e.message === 'Clé refusée.' ? 'inconnue ou révoquée.' : e.message);
      case 'P0002':
        return 'Un point du tracé sort des limites de la ville.';
      case 'P0006':
        return e.message;
      case 'P0001':
        return 'Ville inconnue du serveur.';
      case 'P0008':
        return 'Ce trajet n’existe plus (supprimé ailleurs ?). La liste est rechargée.';
      case 'P0009':
        return 'Déjà ' + MAX_TRAJETS + ' trajets dans cette ville : en retirer un avant d’en ajouter.';
      case '23514':
        return 'Nom (' + NOM_MAX + ' caractères au plus), note (' + NOTE_MAX + ') ou état invalide.';
      case 'PGRST202':
      case 'PGRST205':
      case '42P01':
      case '42883':
        return 'Pas encore disponible : la base n’a pas encore les trajets d’hiver (migration 0038).';
    }
    if (e instanceof TypeError) return 'Pas de connexion au serveur. Vérifier le réseau, puis réessayer.';
    return 'Erreur inattendue : ' + ((e && e.message) || e);
  }

  // ------------------------------------------------------------------
  // L'état de la page
  // ------------------------------------------------------------------
  var S = {
    cle: null,
    porteur: null,
    villeCle: null, // la ville à laquelle la clé est limitée, ou null
    ville: null,
    trajets: [],
    choisi: null, // id du trajet mis en avant dans la liste
    enCours: {}, // id → vrai pendant un changement d'état
    edition: null, // { id, region_id, nom, etat, note, controle, historique, modifie }
    outil: 'ligne', // 'ligne' ou 'courbe' : la sorte des points ajoutés
    occupe: false,
  };

  function stockage(cle, valeur) {
    try {
      if (valeur === undefined) return window.localStorage.getItem(cle);
      if (valeur === null) window.localStorage.removeItem(cle);
      else window.localStorage.setItem(cle, valeur);
    } catch (e) {
      // Navigation privée stricte : la clé ne survivra pas au rechargement.
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Petits outils d'affichage
  // ------------------------------------------------------------------
  // el('button', { class: 'bouton', onclick: f }, ['Texte']) — le texte passe
  // TOUJOURS par des nœuds texte, jamais par innerHTML (un nom de trajet ne
  // peut donc pas injecter de balises).
  function el(balise, attributs, enfants) {
    var n = document.createElement(balise);
    var a = attributs || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v === undefined || v === null || v === false) return;
      if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), v);
      else if (k === 'class') n.className = v;
      else if (k === 'style') n.style.cssText = v;
      else if (k === 'value') n.value = v;
      else n.setAttribute(k, v === true ? '' : v);
    });
    (enfants || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }

  function formatDistance(m) {
    if (m < 1000) return Math.round(m) + ' m';
    return (m / 1000).toFixed(1).replace('.', ',') + ' km';
  }

  function formatDepuis(t) {
    var d = new Date(t.etat_depuis);
    if (isNaN(d.getTime())) return infoEtat(t.etat).phrase;
    var maintenant = new Date();
    var heure = d.getHours() + ' h ' + String(d.getMinutes()).padStart(2, '0');
    var quand;
    if (d.toDateString() === maintenant.toDateString()) quand = 'aujourd’hui, ' + heure;
    else {
      quand = 'le ' + d.toLocaleDateString('fr-CA', { day: 'numeric', month: 'long' });
      if (d.getFullYear() !== maintenant.getFullYear()) quand += ' ' + d.getFullYear();
    }
    return infoEtat(t.etat).phrase + ' depuis ' + quand;
  }

  var minuterieAvis = null;
  function avis(texte, ko) {
    var n = document.getElementById('avis');
    n.textContent = texte;
    n.className = 'visible' + (ko ? ' ko' : '');
    clearTimeout(minuterieAvis);
    minuterieAvis = setTimeout(function () {
      n.className = ko ? 'ko' : '';
    }, ko ? 6000 : 2800);
  }

  function versLatLng(p) {
    return [p.latitude, p.longitude];
  }

  // ------------------------------------------------------------------
  // La carte
  // ------------------------------------------------------------------
  var OSM = '© <a href="https://www.openstreetmap.org/copyright">contributeurs OpenStreetMap</a>';
  var carte = L.map('carte', { zoomControl: false });
  var fonds = {
    'CyclOSM (pistes cyclables)': L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
      subdomains: 'abc',
      maxZoom: 20,
      attribution: OSM + ' · <a href="https://www.cyclosm.org">CyclOSM</a>',
    }),
    OpenStreetMap: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: OSM,
    }),
  };
  fonds['CyclOSM (pistes cyclables)'].addTo(carte);
  L.control.layers(fonds, null, { position: 'topright' }).addTo(carte);
  L.control.zoom({ position: 'topright', zoomInTitle: 'Zoom avant', zoomOutTitle: 'Zoom arrière' }).addTo(carte);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(carte);

  var coucheTrajets = L.layerGroup().addTo(carte);
  var coucheEdition = L.layerGroup().addTo(carte);
  // Ce que l'éditeur met à jour pendant qu'on glisse un point.
  var vueEdition = { halo: null, ligne: null };

  var tactile = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  var TAILLE_POINT = tactile ? 26 : 18;
  var TAILLE_MILIEU = tactile ? 20 : 12;

  function centrerSurVille(id) {
    var v = villeParId(id);
    if (!v) return;
    carte.fitBounds([
      [v.lat - v.delta / 2, v.lng - v.delta / 2],
      [v.lat + v.delta / 2, v.lng + v.delta / 2],
    ]);
  }

  function centrerSurPoints(points) {
    if (!points || points.length < 1) return;
    carte.fitBounds(L.latLngBounds(points.map(versLatLng)), { padding: [40, 40], maxZoom: 17 });
  }

  // Les trajets enregistrés de la ville. Pendant une édition, ils restent
  // visibles mais pâles, et ne réagissent plus au toucher.
  function dessinerTrajets() {
    coucheTrajets.clearLayers();
    var pale = !!S.edition;
    S.trajets.forEach(function (t) {
      if (S.edition && S.edition.id === t.id) return; // l'éditeur le dessine
      var ll = (t.points || []).map(versLatLng);
      if (ll.length < 2) return;
      var choisi = t.id === S.choisi && !pale;
      L.polyline(ll, {
        color: '#ffffff',
        weight: choisi ? 13 : 9,
        opacity: pale ? 0.5 : 0.95,
        interactive: false,
      }).addTo(coucheTrajets);
      var ligne = L.polyline(ll, {
        color: infoEtat(t.etat).couleur,
        weight: choisi ? 7 : 5,
        opacity: pale ? 0.4 : 1,
        dashArray: t.etat === 'ferme' ? '10 8' : null,
        interactive: !pale,
      });
      if (!pale) {
        ligne.bindTooltip(el('span', {}, [t.nom]), { sticky: true });
        ligne.on('click', function (e) {
          L.DomEvent.stopPropagation(e);
          choisir(t.id, false);
        });
      }
      ligne.addTo(coucheTrajets);
    });
  }

  function choisir(id, centrer) {
    S.choisi = id;
    dessinerTrajets();
    afficherListe();
    var t = trouverTrajet(id);
    if (t && centrer) centrerSurPoints(t.points);
    var carteListe = document.querySelector('[data-trajet="' + id + '"]');
    if (carteListe && !centrer) carteListe.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function trouverTrajet(id) {
    for (var i = 0; i < S.trajets.length; i++) if (S.trajets[i].id === id) return S.trajets[i];
    return null;
  }

  // ------------------------------------------------------------------
  // Le dessin (mode édition)
  // ------------------------------------------------------------------
  function nouveauPoint(latlng) {
    return { latitude: latlng.lat, longitude: latlng.lng, lisse: S.outil === 'courbe' };
  }

  // À appeler AVANT chaque modification du dessin : c'est ce que « Annuler »
  // rétablit.
  function memoriser() {
    var ed = S.edition;
    ed.historique.push(JSON.stringify(ed.controle));
    if (ed.historique.length > 200) ed.historique.shift();
    ed.modifie = true;
  }

  function annulerDernier() {
    var ed = S.edition;
    if (!ed || ed.historique.length === 0) return;
    ed.controle = JSON.parse(ed.historique.pop());
    carte.closePopup();
    dessinerEdition();
  }

  // Les deux traits seulement (pendant un glissement : les repères, eux,
  // ne bougent pas — le repère glissé suit le doigt tout seul).
  function majLignes() {
    var r = ligneDuDessin(S.edition.controle);
    var ll = r.points.map(versLatLng);
    vueEdition.halo.setLatLngs(ll);
    vueEdition.ligne.setLatLngs(ll);
    majInfosTrace(r);
    return r;
  }

  function dessinerEdition() {
    coucheEdition.clearLayers();
    var ed = S.edition;
    if (!ed) return;
    var n = ed.controle.length;
    var r = ligneDuDessin(ed.controle);
    var ll = r.points.map(versLatLng);

    vueEdition.halo = L.polyline(ll, { color: '#ffffff', weight: 11, opacity: 0.95, interactive: false }).addTo(
      coucheEdition
    );
    vueEdition.ligne = L.polyline(ll, {
      color: infoEtat(ed.etat).couleur,
      weight: 5,
      dashArray: ed.etat === 'ferme' ? '10 8' : null,
      interactive: false,
    }).addTo(coucheEdition);

    // Les petits ronds entre deux points : les toucher ou les glisser ajoute
    // un point à cet endroit.
    r.milieux.forEach(function (milieu, i) {
      var g = L.marker(versLatLng(milieu), {
        draggable: true,
        keyboard: false,
        title: 'Ajouter un point ici',
        zIndexOffset: -500,
        icon: L.divIcon({ className: 'pt-milieu', iconSize: [TAILLE_MILIEU, TAILLE_MILIEU] }),
      });
      g.on('dragstart', function () {
        memoriser();
        ed.controle.splice(i + 1, 0, nouveauPoint(g.getLatLng()));
        carte.getContainer().classList.add('glisse');
      });
      g.on('drag', function () {
        var p = g.getLatLng();
        ed.controle[i + 1].latitude = p.lat;
        ed.controle[i + 1].longitude = p.lng;
        majLignes();
      });
      g.on('dragend', finGlissement);
      g.on('click', function () {
        if (ed.controle.length >= MAX_CONTROLE) return avis(MAX_CONTROLE + ' points au plus.', true);
        memoriser();
        ed.controle.splice(i + 1, 0, nouveauPoint(g.getLatLng()));
        dessinerEdition();
      });
      g.addTo(coucheEdition);
    });

    ed.controle.forEach(function (p, i) {
      var bout = i === 0 || i === n - 1;
      var classes = 'pt ' + (p.lisse && !bout ? 'pt-courbe' : 'pt-ligne');
      if (i === 0 && n > 1) classes += ' pt-debut';
      if (i === n - 1) classes += ' pt-fin';
      var m = L.marker(versLatLng(p), {
        draggable: true,
        keyboard: false,
        title: 'Point ' + (i + 1) + ' sur ' + n,
        zIndexOffset: i === n - 1 ? 1000 : 0,
        icon: L.divIcon({ className: classes, iconSize: [TAILLE_POINT, TAILLE_POINT] }),
      });
      m.on('dragstart', function () {
        memoriser();
        carte.closePopup();
        carte.getContainer().classList.add('glisse');
      });
      m.on('drag', function () {
        var q = m.getLatLng();
        ed.controle[i].latitude = q.lat;
        ed.controle[i].longitude = q.lng;
        majLignes();
      });
      m.on('dragend', finGlissement);
      m.on('click', function () {
        ouvrirMenuPoint(i, m.getLatLng());
      });
      m.addTo(coucheEdition);
    });

    majInfosTrace(r);
  }

  function finGlissement() {
    carte.getContainer().classList.remove('glisse');
    dessinerEdition();
  }

  // Le menu d'un point : pointe ou arrondi, ou le retirer.
  function ouvrirMenuPoint(i, latlng) {
    var ed = S.edition;
    var n = ed.controle.length;
    var p = ed.controle[i];
    var bout = i === 0 || i === n - 1;
    function sorte(lisse) {
      return function () {
        if (bout || p.lisse === lisse) return;
        memoriser();
        p.lisse = lisse;
        carte.closePopup();
        dessinerEdition();
      };
    }
    var contenu = el('div', { class: 'menu-point' }, [
      el('div', { class: 'titre' }, ['Point ' + (i + 1) + ' sur ' + n]),
      bout
        ? el('div', { class: 'discret' }, ['Un bout du tracé est toujours une pointe.'])
        : el('div', { class: 'segmente' }, [
            el('button', { type: 'button', 'data-outil': 'ligne', 'aria-pressed': String(!p.lisse), onclick: sorte(false) }, [
              '◼ Pointe',
            ]),
            el('button', { type: 'button', 'data-outil': 'courbe', 'aria-pressed': String(!!p.lisse), onclick: sorte(true) }, [
              '● Arrondi',
            ]),
          ]),
      el(
        'button',
        {
          type: 'button',
          class: 'bouton danger',
          onclick: function () {
            memoriser();
            ed.controle.splice(i, 1);
            carte.closePopup();
            dessinerEdition();
          },
        },
        ['Retirer ce point']
      ),
    ]);
    L.popup({ offset: [0, -TAILLE_POINT / 2], autoPan: true }).setLatLng(latlng).setContent(contenu).openOn(carte);
  }

  // Toucher la carte (en édition) ajoute un point au bout bleu. Un toucher qui
  // sert à FERMER le menu d'un point n'en ajoute pas.
  var fermetureMenu = 0;
  carte.on('popupclose', function () {
    fermetureMenu = Date.now();
  });
  carte.on('click', function (e) {
    var ed = S.edition;
    if (!ed) return;
    if (Date.now() - fermetureMenu < 350) return;
    if (ed.controle.length >= MAX_CONTROLE) return avis(MAX_CONTROLE + ' points au plus.', true);
    memoriser();
    ed.controle.push(nouveauPoint(e.latlng));
    dessinerEdition();
  });

  document.addEventListener('keydown', function (e) {
    if (!S.edition) return;
    var dansUnChamp = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !dansUnChamp) {
      e.preventDefault();
      annulerDernier();
    }
  });

  window.addEventListener('beforeunload', function (e) {
    if (S.edition && S.edition.modifie) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ------------------------------------------------------------------
  // Le panneau
  // ------------------------------------------------------------------
  var panneau = document.getElementById('panneau');
  function vider() {
    while (panneau.firstChild) panneau.removeChild(panneau.firstChild);
  }

  function boutonsEtats(actuel, auChoix, desactive) {
    return el(
      'div',
      { class: 'segmente', role: 'group', 'aria-label': 'État' },
      ORDRE_ETATS.map(function (etat) {
        return el(
          'button',
          {
            type: 'button',
            'data-etat': etat,
            'aria-pressed': String(actuel === etat),
            disabled: desactive,
            onclick: function () {
              auChoix(etat);
            },
          },
          [ETATS[etat].nom]
        );
      })
    );
  }

  function afficherEcranCle(message) {
    nettoyerEdition();
    coucheTrajets.clearLayers();
    vider();
    var champ = el('input', {
      type: 'password',
      autocomplete: 'off',
      placeholder: 'Coller la clé ou le lien complet',
      'aria-label': 'Clé',
    });
    panneau.appendChild(
      el('div', { class: 'ecran-cle' }, [
        el('h1', {}, ['Trajets d’hiver']),
        el('p', {}, [
          'Cette page sert à dessiner les pistes et passerelles qui ferment l’hiver, et à changer leur état. ',
          'Elle demande une clé, transmise dans le lien complet (la partie « #cle=… »).',
        ]),
        el(
          'form',
          {
            onsubmit: function (e) {
              e.preventDefault();
              var v = champ.value.trim();
              var i = v.indexOf('#cle=');
              if (i >= 0) v = v.slice(i + 5);
              if (v) ouvrirAvecCle(v);
            },
          },
          [champ, el('button', { class: 'bouton primaire', type: 'submit' }, ['Ouvrir'])]
        ),
        message ? el('p', { class: 'message ko' }, [message]) : null,
      ])
    );
  }

  function afficherChargement(texte) {
    vider();
    panneau.appendChild(el('p', { class: 'discret' }, [texte || 'Chargement…']));
  }

  function afficherListe() {
    if (S.edition || !S.cle) return;
    vider();
    var ville = villeParId(S.ville);

    var choixVille = el(
      'select',
      {
        'aria-label': 'Ville',
        disabled: !!S.villeCle,
        onchange: function (e) {
          changerVille(e.target.value);
        },
      },
      VILLES.map(function (v) {
        return el('option', { value: v.id, selected: v.id === S.ville }, [v.nom]);
      })
    );

    // En-tête compact (2026-11-12, demande de Nicolas : voir plus de trajets
    // dans la colonne) : la ville et « + Nouveau » sur la même rangée.
    panneau.appendChild(el('h1', {}, ['Trajets d’hiver']));
    panneau.appendChild(
      el('div', { class: 'entete' }, [
        choixVille,
        el(
          'button',
          {
            type: 'button',
            class: 'bouton primaire',
            disabled: S.trajets.length >= MAX_TRAJETS,
            title: S.trajets.length >= MAX_TRAJETS ? MAX_TRAJETS + ' trajets au plus par ville' : 'Dessiner un nouveau trajet',
            onclick: function () {
              commencerEdition(null);
            },
          },
          ['+ Nouveau']
        ),
      ])
    );
    panneau.appendChild(
      el('p', { class: 'discret cle' }, [
        'Clé : ' + S.porteur + (S.villeCle ? ' (' + ville.nom + ' seulement)' : '') + ' · ',
        el('button', { type: 'button', class: 'lien', onclick: oublierCle }, ['Oublier la clé']),
        S.trajets.length ? ' · ' + S.trajets.length + ' / ' + MAX_TRAJETS + ' trajets' : '',
      ])
    );

    if (S.trajets.length === 0) {
      panneau.appendChild(
        el('div', { class: 'vide' }, [
          'Aucun trajet d’hiver à ' + ville.nom + ' pour l’instant. « Nouveau trajet », puis touchez la carte pour poser les points.',
        ])
      );
    }

    var liste = el('ul', { class: 'liste' });
    S.trajets.forEach(function (t) {
      var info = infoEtat(t.etat);
      liste.appendChild(
        // Une fiche en trois ou quatre rangées : le nom ; « depuis » et la
        // distance ; la note (deux lignes, entière quand le trajet est choisi) ;
        // les trois états avec « Modifier » à côté.
        el('li', { class: 'trajet' + (t.id === S.choisi ? ' choisi' : ''), 'data-trajet': t.id }, [
          el('div', { class: 'haut' }, [
            el('span', { class: 'pastille', style: 'background:' + info.couleur }),
            el(
              'button',
              {
                type: 'button',
                class: 'nom',
                title: 'Voir sur la carte',
                onclick: function () {
                  choisir(t.id, true);
                },
              },
              [t.nom]
            ),
          ]),
          el('div', { class: 'discret infos-trajet' }, [
            formatDepuis(t) + ' · ' + formatDistance(t.distance_m),
            // Relié à une source officielle (migration 0040) : l'état se met à
            // jour tout seul ; un changement fait ici tient jusqu'au prochain
            // changement chez la source.
            t.source
              ? el(
                  'span',
                  {
                    class: 'auto',
                    title:
                      'État mis à jour automatiquement d’après une source officielle. Un changement fait ici tient jusqu’au prochain changement chez la source.',
                  },
                  ['auto']
                )
              : null,
          ]),
          t.note ? el('div', { class: 'note', title: t.note }, [t.note]) : null,
          el('div', { class: 'rangee-etats' }, [
            boutonsEtats(
              t.etat,
              function (etat) {
                changerEtat(t, etat);
              },
              !!S.enCours[t.id]
            ),
            el(
              'button',
              {
                type: 'button',
                class: 'bouton modifier',
                title: 'Modifier le tracé, le nom ou la note',
                onclick: function () {
                  commencerEdition(t);
                },
              },
              ['Modifier']
            ),
          ]),
        ])
      );
    });
    panneau.appendChild(liste);

    panneau.appendChild(
      el('div', { class: 'legende' }, [
        el('div', {}, [el('span', { class: 'trait', style: 'background:' + ETATS.ouvert.couleur }), 'Ouvert : praticable, déneigé']),
        el('div', {}, [el('span', { class: 'trait', style: 'background:' + ETATS.partiel.couleur }), 'Partiel : ouvert en partie ou mal entretenu']),
        el('div', {}, [el('span', { class: 'trait ferme' }), 'Fermé : ne pas l’emprunter']),
      ])
    );
  }

  // Le panneau d'édition est construit UNE fois par édition (pour ne pas
  // perdre le curseur dans le champ du nom) ; seuls les chiffres du tracé et
  // l'état des boutons sont mis à jour ensuite (majInfosTrace).
  var champsEdition = {};

  function afficherEdition() {
    var ed = S.edition;
    vider();
    var nouveau = !ed.id;

    var nom = el('input', {
      type: 'text',
      maxlength: String(NOM_MAX),
      value: ed.nom,
      placeholder: 'Ex. : Piste multifonctionnelle des Carrières',
      oninput: function (e) {
        ed.nom = e.target.value;
        ed.modifie = true;
      },
    });
    var compteur = el('span', { class: 'compteur' }, [(ed.note || '').length + ' / ' + NOTE_MAX]);
    var note = el('textarea', {
      maxlength: String(NOTE_MAX),
      placeholder: 'Ex. : Fermée du 1er décembre au 1er avril. Contourner par la rue Beaubien.',
      oninput: function (e) {
        ed.note = e.target.value;
        ed.modifie = true;
        compteur.textContent = ed.note.length + ' / ' + NOTE_MAX;
      },
    });
    note.value = ed.note || '';

    var etats = el('div');
    function redessinerEtats() {
      while (etats.firstChild) etats.removeChild(etats.firstChild);
      etats.appendChild(
        boutonsEtats(ed.etat, function (etat) {
          ed.etat = etat;
          ed.modifie = true;
          redessinerEtats();
          dessinerEdition();
        })
      );
    }
    redessinerEtats();

    var outils = el('div');
    function redessinerOutils() {
      while (outils.firstChild) outils.removeChild(outils.firstChild);
      outils.appendChild(
        el('div', { class: 'segmente', role: 'group', 'aria-label': 'Sorte des nouveaux points' }, [
          el(
            'button',
            {
              type: 'button',
              'data-outil': 'ligne',
              'aria-pressed': String(S.outil === 'ligne'),
              onclick: function () {
                S.outil = 'ligne';
                redessinerOutils();
              },
            },
            ['╱ Ligne droite']
          ),
          el(
            'button',
            {
              type: 'button',
              'data-outil': 'courbe',
              'aria-pressed': String(S.outil === 'courbe'),
              onclick: function () {
                S.outil = 'courbe';
                redessinerOutils();
              },
            },
            ['∿ Courbe']
          ),
        ])
      );
    }
    redessinerOutils();

    champsEdition.annuler = el('button', { type: 'button', class: 'bouton', onclick: annulerDernier }, ['↶ Annuler']);
    champsEdition.inverser = el(
      'button',
      {
        type: 'button',
        class: 'bouton',
        title: 'Pour prolonger le tracé par l’autre bout',
        onclick: function () {
          memoriser();
          ed.controle.reverse();
          carte.closePopup();
          dessinerEdition();
        },
      },
      ['⇄ Inverser le sens']
    );
    champsEdition.effacer = el(
      'button',
      {
        type: 'button',
        class: 'bouton danger',
        onclick: function () {
          if (!window.confirm('Effacer tous les points du tracé ? (« Annuler » les rétablit.)')) return;
          memoriser();
          ed.controle = [];
          carte.closePopup();
          dessinerEdition();
        },
      },
      ['Effacer le tracé']
    );
    champsEdition.infos = el('p', { class: 'infos discret' });
    champsEdition.message = el('p', { class: 'message' });
    champsEdition.enregistrer = el('button', { type: 'button', class: 'bouton primaire', onclick: enregistrer }, [
      'Enregistrer',
    ]);

    panneau.appendChild(el('h2', {}, [nouveau ? 'Nouveau trajet' : 'Modifier le trajet']));
    panneau.appendChild(el('p', { class: 'discret' }, [villeParId(ed.region_id).nom]));
    panneau.appendChild(el('label', { class: 'champ' }, ['Nom', nom]));
    panneau.appendChild(el('div', { class: 'sous-titre' }, ['État']));
    panneau.appendChild(etats);
    panneau.appendChild(el('label', { class: 'champ' }, ['Note (facultative) ', compteur, note]));

    panneau.appendChild(el('h3', {}, ['Tracé']));
    panneau.appendChild(el('div', { class: 'sous-titre' }, ['Les prochains points']));
    panneau.appendChild(outils);
    panneau.appendChild(
      el('div', { class: 'aide' }, [
        el('p', {}, ['Touchez la carte : chaque toucher ajoute un point au bout BLEU du tracé.']),
        el('p', {}, ['« Ligne droite » y va tout droit ; « Courbe » arrondit le tracé en passant par les points.']),
        el('p', {}, [
          'Glissez un point pour le déplacer, touchez-le pour le changer ou le retirer. Glissez un petit rond (entre deux points) pour en ajouter un.',
        ]),
      ])
    );
    panneau.appendChild(el('div', { class: 'outils' }, [champsEdition.annuler, champsEdition.inverser, champsEdition.effacer]));
    panneau.appendChild(champsEdition.infos);

    panneau.appendChild(
      el('div', { class: 'actions-edition' }, [
        champsEdition.enregistrer,
        el('button', { type: 'button', class: 'bouton', onclick: quitterEdition }, ['Annuler']),
      ])
    );
    panneau.appendChild(champsEdition.message);
    if (!nouveau) {
      panneau.appendChild(
        el('button', { type: 'button', class: 'bouton danger large', style: 'margin-top:14px', onclick: supprimer }, [
          'Supprimer ce trajet',
        ])
      );
    }
    if (nouveau) nom.focus();
  }

  function majInfosTrace(r) {
    var ed = S.edition;
    if (!ed || !champsEdition.infos) return;
    var n = ed.controle.length;
    var texte =
      n === 0
        ? 'Aucun point pour l’instant.'
        : n + ' point' + (n > 1 ? 's' : '') + (r.points.length > 1 ? ' · ' + formatDistance(longueurM(r.points)) : '');
    champsEdition.infos.textContent = texte;
    champsEdition.annuler.disabled = ed.historique.length === 0;
    champsEdition.inverser.disabled = n < 2;
    champsEdition.effacer.disabled = n === 0;
  }

  function message(texte, ko) {
    if (!champsEdition.message) return;
    champsEdition.message.textContent = texte || '';
    champsEdition.message.className = 'message' + (ko ? ' ko' : '');
  }

  // ------------------------------------------------------------------
  // Les gestes
  // ------------------------------------------------------------------
  function commencerEdition(t) {
    S.edition = {
      id: t ? t.id : null,
      region_id: t ? t.region_id : S.ville,
      nom: t ? t.nom : '',
      etat: t && ETATS[t.etat] ? t.etat : 'ferme',
      note: t ? t.note || '' : '',
      controle: t ? JSON.parse(JSON.stringify(t.controle)) : [],
      historique: [],
      modifie: false,
    };
    S.choisi = t ? t.id : S.choisi;
    carte.doubleClickZoom.disable();
    carte.getContainer().classList.add('edition');
    dessinerTrajets();
    afficherEdition();
    dessinerEdition();
    if (t) centrerSurPoints(t.points);
  }

  // Sort du mode édition sans rien redessiner (les appelants s'en chargent).
  function nettoyerEdition() {
    S.edition = null;
    champsEdition = {};
    carte.closePopup();
    carte.doubleClickZoom.enable();
    carte.getContainer().classList.remove('edition', 'glisse');
    coucheEdition.clearLayers();
  }

  function quitterEdition(sansDemander) {
    if (S.edition && S.edition.modifie && sansDemander !== true) {
      if (!window.confirm('Abandonner les changements de ce trajet ?')) return;
    }
    nettoyerEdition();
    dessinerTrajets();
    afficherListe();
  }

  function trier() {
    S.trajets.sort(function (a, b) {
      return a.nom.localeCompare(b.nom, 'fr');
    });
  }

  function remplacer(t) {
    var i = S.trajets.findIndex(function (x) {
      return x.id === t.id;
    });
    if (i >= 0) S.trajets[i] = t;
    else S.trajets.push(t);
    trier();
  }

  function enregistrer() {
    var ed = S.edition;
    if (S.occupe) return;
    var nom = ed.nom.replace(/\s+/g, ' ').trim();
    if (!nom) return message('Donnez un nom au trajet.', true);
    if (ed.controle.length < 2) return message('Il faut au moins deux points.', true);
    var r = ligneDuDessin(ed.controle);
    if (longueurM(r.points) < LONGUEUR_MIN_M) return message('Trajet trop court (' + LONGUEUR_MIN_M + ' m au moins).', true);

    S.occupe = true;
    champsEdition.enregistrer.disabled = true;
    message('Enregistrement…');
    api
      .enregistrer({
        id: ed.id,
        region_id: ed.region_id,
        nom: nom,
        etat: ed.etat,
        note: ed.note.trim() || null,
        controle: ed.controle.map(function (p) {
          var q = pointPropre(p);
          q.lisse = !!p.lisse;
          return q;
        }),
        points: r.points.map(pointPropre),
      })
      .then(function (t) {
        remplacer(t);
        S.choisi = t.id;
        quitterEdition(true);
        avis('« ' + t.nom + ' » est enregistré.');
      })
      .catch(function (e) {
        traiterErreur(e, true);
      })
      .then(function () {
        S.occupe = false;
        if (champsEdition.enregistrer) champsEdition.enregistrer.disabled = false;
      });
  }

  function changerEtat(t, etat) {
    if (t.etat === etat || S.enCours[t.id]) return;
    S.enCours[t.id] = true;
    afficherListe();
    api
      .changerEtat(t.id, etat)
      .then(function (nouveau) {
        remplacer(nouveau);
        avis('« ' + nouveau.nom + ' » : ' + infoEtat(nouveau.etat).nom.toLowerCase() + '.');
      })
      .catch(function (e) {
        traiterErreur(e, false);
      })
      .then(function () {
        delete S.enCours[t.id];
        if (!S.cle) return; // clé refusée : l'écran de la clé reste affiché
        dessinerTrajets();
        afficherListe();
      });
  }

  function supprimer() {
    var ed = S.edition;
    if (!ed || !ed.id || S.occupe) return;
    if (!window.confirm('Supprimer « ' + ed.nom + ' » ? Les usagers ne le verront plus.')) return;
    S.occupe = true;
    message('Suppression…');
    api
      .supprimer(ed.id)
      .then(function () {
        var nom = ed.nom;
        S.trajets = S.trajets.filter(function (x) {
          return x.id !== ed.id;
        });
        S.choisi = null;
        quitterEdition(true);
        avis('« ' + nom + ' » est supprimé.');
      })
      .catch(function (e) {
        traiterErreur(e, true);
      })
      .then(function () {
        S.occupe = false;
      });
  }

  // Une erreur du serveur : clé refusée → retour à l'écran de la clé ; trajet
  // disparu → on recharge ; le reste s'affiche.
  function traiterErreur(e, enEdition) {
    var texte = messageErreur(e);
    if (e && e.code === 'P0007') {
      stockage(CLE_STOCKEE, null);
      S.cle = null;
      afficherEcranCle(texte);
      return;
    }
    if (e && e.code === 'P0008') {
      avis(texte, true);
      nettoyerEdition();
      chargerVille();
      return;
    }
    if (enEdition && S.edition) message(texte, true);
    else avis(texte, true);
  }

  function oublierCle() {
    if (!window.confirm('Oublier la clé sur cet appareil ? Il faudra rouvrir le lien complet pour revenir.')) return;
    stockage(CLE_STOCKEE, null);
    S.cle = null;
    afficherEcranCle();
  }

  function changerVille(id) {
    S.ville = id;
    S.choisi = null;
    stockage(VILLE_STOCKEE, id);
    centrerSurVille(id);
    chargerVille();
  }

  function chargerVille() {
    afficherChargement('Chargement des trajets…');
    coucheTrajets.clearLayers();
    coucheEdition.clearLayers();
    return api
      .lister(S.ville)
      .then(function (liste) {
        S.trajets = liste || [];
        trier();
        dessinerTrajets();
        afficherListe();
      })
      .catch(function (e) {
        S.trajets = [];
        afficherListe();
        avis(messageErreur(e), true);
      });
  }

  // ------------------------------------------------------------------
  // Démarrage
  // ------------------------------------------------------------------
  function cleDeLAdresse() {
    var h = window.location.hash.replace(/^#/, '');
    if (!h) return null;
    var cle = new URLSearchParams(h).get('cle');
    return cle ? cle.trim() : null;
  }

  function ouvrirAvecCle(cle) {
    afficherChargement('Vérification de la clé…');
    api
      .verifierCle(cle)
      .then(function (info) {
        S.cle = cle;
        S.porteur = info.porteur;
        S.villeCle = info.region_id || null;
        stockage(CLE_STOCKEE, cle);
        var memorisee = stockage(VILLE_STOCKEE);
        S.ville = S.villeCle || (villeParId(memorisee) ? memorisee : 'montreal');
        centrerSurVille(S.ville);
        chargerVille();
      })
      .catch(function (e) {
        if (e && e.code === 'P0007') stockage(CLE_STOCKEE, null);
        afficherEcranCle(messageErreur(e));
      });
  }

  function demarrer() {
    var cle = cleDeLAdresse();
    if (cle) {
      // La clé quitte la barre d'adresse (et l'historique) aussitôt lue.
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } else {
      cle = stockage(CLE_STOCKEE);
    }
    if (!cle) {
      centrerSurVille('montreal');
      afficherEcranCle();
      return;
    }
    ouvrirAvecCle(cle);
  }

  // Un nouveau lien collé dans la barre d'adresse, page ouverte.
  window.addEventListener('hashchange', function () {
    if (cleDeLAdresse()) demarrer();
  });

  centrerSurVille('montreal');
  demarrer();
})();
