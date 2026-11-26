# Découplage entre les AE/AV par nature de ressource et la hiérarchie d'AC par organisation

Le cahier des charges impose deux axes de structuration indépendants : une hiérarchie d'**AC** sur au moins trois niveaux calquée sur l'organigramme de l'organisation (`AC Racine` niveau 1 → `AC Direction` niveau 2 → `AC Service` niveau 3) et des **AE** / **AV** spécialisées par *nature de ressource* (messagerie, routeurs, utilisateurs, etc.). Nous découplons ces deux axes : les **AE** et **AV** sont mutualisées par nature de ressource et chaque **AE** route les demandes authentifiées vers l'**AC** de niveau 3 correspondant au rattachement organisationnel du demandeur.

## Considered Options

- **Dupliquer chaque couple (AE, AV) par nature sous chaque AC de niveau 3** : crée un produit cartésien d'instances ($\text{Directions} \times \text{Services} \times \text{Natures}$) et force chaque ressource à connaître l'AE spécifique de son sous-service.
- **Mutualiser les AE et AV par nature de ressource avec routage vers l'AC de niveau 3** : chaque ressource dispose d'un point d'entrée unique pour sa nature (`AE-Messagerie`, `AE-Routeurs`, `AV-Messagerie`, `AV-Routeurs`…), tandis que la topologie d'AC évolue librement au rythme des directions et services.

## Consequences

- L'ajout d'une nouvelle direction (niveau 2) ou d'un nouveau service (niveau 3) n'exige que le déploiement d'une nouvelle instance d'AC et sa certification par son AC parente, sans dupliquer les AE ni les AV.
- La certification des **AC Filles** (niveau 1 → 2 et niveau 2 → 3) relève d'une administration interne directe entre AC parente et AC fille, sans passer par les AE dédiées aux porteurs finaux.
