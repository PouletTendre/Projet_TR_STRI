# Découplage entre les AE/AV par nature de ressource et la hiérarchie d'AC par direction

Le système doit simultanément refléter l'organigramme fonctionnel de l'organisation sur au moins trois niveaux d'Autorités de Certification (**AC Racine** niveau 1 $\rightarrow$ **AC de Direction** niveau 2 $\rightarrow$ **AC de Service** niveau 3) et spécialiser les **Autorités d'Enregistrement (AE)** ainsi que les **Autorités de Validation (AV)** selon la *nature* de la ressource (humaine, matérielle comme un routeur, ou logicielle comme un client de messagerie). Nous découplons l'axe fonctionnel (nature de ressource) de l'axe organisationnel (hiérarchie d'AC) : chaque nature de ressource dispose de son AE et de son AV dédiées, et l'AE route les demandes authentifiées vers la file JMS de l'AC de niveau 3 correspondant au rattachement organisationnel du demandeur.

## Considered Options

- **Dupliquer chaque couple (AE, AV) par nature sous chaque AC de niveau 3** : entraîne une explosion combinatoire du nombre d'instances ($\text{Directions} \times \text{Services} \times \text{Natures de ressources}$) et oblige une ressource à connaître l'adresse d'une AE propre à son sous-service.
- **Mutualiser les AE et AV par nature de ressource avec routage vers l'AC de niveau 3** : une ressource s'adresse toujours au point d'entrée de sa nature (ex. `AE-Messagerie`, `AE-Routeurs`) ; l'AE vérifie l'identité et l'unité organisationnelle de l'entité puis adresse la demande à l'AC de niveau 3 compétente.

## Consequences

- L'ajout d'une nouvelle direction (niveau 2) ou d'un nouveau service (niveau 3) ne nécessite que le déploiement d'une nouvelle instance d'AC et l'émission de son certificat par son AC parente, sans dupliquer les AE ni les AV.
- L'émission des certificats d'**AC Filles** (niveau 1 $\rightarrow$ niveau 2 et niveau 2 $\rightarrow$ niveau 3) s'effectue par administration interne directe entre AC parente et AC fille, sans transiter par les AE destinées aux ressources finales.
