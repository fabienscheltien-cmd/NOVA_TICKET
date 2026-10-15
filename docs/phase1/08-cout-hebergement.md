# 08 — Coût d'hébergement OVH et modèle de facturation

## Limites de cette estimation
Je n'ai pas pu consulter les pages tarifaires officielles OVHcloud en euros (accès réseau limité à des résultats de recherche). Les chiffres ci-dessous sont **partiels** ; ce qui n'est pas vérifié est marqué *non sourcé*. **À refaire avec le simulateur OVHcloud avant toute décision tarifaire.** Confiance : faible à moyenne.

## Faits relevés (recherche du 15/10/2026)
| Élément | Valeur relevée | Source | Remarque |
|---|---|---|---|
| Instance b3-8 (2 vCore, 8 Go) | ≈ 0,0566 USD/h, soit ≈ 41 USD/mois (calcul : × 730 h) | [page prix OVHcloud (USD)](https://www.ovhcloud.com/en/public-cloud/prices) | Colonne avec prix de lancement et prix au 1er mars 2026 : à vérifier en EUR |
| Instance b3-8, suivi tiers | ≈ 28 EUR/mois, 0,0512 EUR/h | [vpsbenchmarks](https://www.vpsbenchmarks.com/hosters/ovhcloud/plans/b3-8) | Source non officielle, incohérente avec le calcul horaire |
| Instance b3-16 (4 vCore, 16 Go) | ≈ 0,1132 USD/h, soit ≈ 83 USD/mois | page prix OVHcloud (USD) | Tiers : 44 à 67 EUR/mois selon l'instantané |
| Object Storage Standard 1-AZ | 0,00000972 EUR/Go·h, soit ≈ 0,0071 EUR/Go/mois (calcul) | [FAQ OVHcloud Object Storage](https://docs.ovhcloud.com/fr/guides/storage-and-backup/object-storage/s3-faq) | Requêtes et sortie de données : non relevées |
| PostgreSQL managé | Plans Essential (1 nœud, sans haute disponibilité), Business (multi-nœuds, bascule automatique), Enterprise. Facturation à l'usage, IOPS, sauvegardes et trafic inclus | [OVHcloud PostgreSQL](https://www.ovhcloud.com/fr/public-cloud/postgresql/) | **Prix non relevés** |

## Estimation par scénario (échelle cible : 500 sites, 100 000 actifs, 1 M de tickets)
Hypothèses : API + worker sur 2 instances b3-8 en production, 1 instance b3-8 de staging, Redis et ClamAV dans des conteneurs sur ces instances (pas de service managé), pièces jointes ≈ 3 To à pleine échelle (1 M de tickets × ≈ 2 photos × ≈ 1,5 Mo, **estimation**) + copie de sauvegarde dans un second bucket.

| Poste | Estimation mensuelle | Statut |
|---|---|---|
| 3 instances b3-8 | ≈ 84 à 123 EUR | fourchette issue des deux sources ci-dessus |
| Object Storage ≈ 6 To (principal + sauvegarde) | ≈ 43 EUR | calcul sur tarif Standard 1-AZ ; hors requêtes et sortie |
| PostgreSQL managé (Business, haute disponibilité) | **inconnu** | *non sourcé* : à relever sur le simulateur |
| E-mail transactionnel et SMS (prestataire européen) | **inconnu** | à choisir, dépend du volume |
| Observabilité, DNS, nom de domaine | **inconnu**, faible | auto-hébergé en France |
| **Sous-total sourcé** | **≈ 130 à 170 EUR hors base de données, e-mail et SMS** | |

Le coût d'hébergement est donc dominé par la **base de données managée**, que je n'ai pas pu chiffrer. À échelle initiale (quelques organisations), le stockage tend vers quelques euros.

## Facteurs de coût (faits de conception)
- Stockage : proportionnel à l'**activité** (tickets, photos), pas au nombre d'actifs.
- Base de données : le nombre d'actifs pèse peu (100 000 lignes sont négligeables) ; les tickets, messages et journal d'audit dominent.
- Calcul : proportionnel au nombre d'utilisateurs actifs et de synchronisations mobiles.

## Recommandation de modèle de facturation : **par site**, avec paliers
| Critère | Par site | Par actif |
|---|---|---|
| Lien avec le coût réel | Moyen (le site est un proxy de l'activité) | **Faible** (l'actif pèse peu en coût) |
| Prévisibilité pour le client | **Forte** | Variable |
| Effet sur l'usage | Neutre | **Dissuade de déclarer les équipements**, ce qui dégrade la valeur de la GMAO |
| Simplicité commerciale | **Élevée** | Moyenne (inventaires à suivre) |
| Faiblesse | Un site de 50 m² et un site de 50 000 m² au même prix | Facture imprévisible après import |

Atténuation de la faiblesse du modèle par site : **paliers selon le nombre de locaux** (ou la surface) et plafond d'usage raisonnable de stockage. Le niveau des prix est une décision commerciale qui vous appartient ; l'infrastructure n'est pas le critère discriminant (à 500 sites, l'hébergement hors base de données représente environ 0,3 EUR par site et par mois, calcul sur le sous-total ci-dessus).

## Disponibilité visée (99,9 %)
Objectif non validé : dépend du plan de base de données retenu (Business ou Enterprise) et des engagements contractuels d'OVHcloud, **à lire dans les conditions de service avant de s'engager auprès d'un client**. RPO ≤ 1 h : sauvegardes continues (journaux de transactions) à vérifier sur le plan retenu. RTO ≤ 4 h : exercice de restauration chronométré prévu à l'incrément 12.
