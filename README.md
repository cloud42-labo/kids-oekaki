# Kids Oekaki

子どもがタブレットで迷わず描き、作品を残せるお絵かきアプリです。

2026-09-20に `cloud42-labo/experimental/kids-oekaki` から正式Product Repositoryへ移行しました。以後の開発・CI/CD・Release成果物のSSoTはこのRepositoryです。

## Current state

- Version: `0.13.5`
- React + TypeScript + Vite + Canvas 2D
- PWA / offline対応
- Pointer Events + coalesced samples
- Undo / Redo / Layer
- Magic Brush / Stamp
- PNG保存
- Playwright E2E
- Target: `v1.0.0`

## Development

```bash
npm ci
npm run dev
```

## Verification

```bash
npm run build
npm run test:e2e
```

## Architecture

- [Architecture](docs/ARCHITECTURE.md)
- [PoC analysis](docs/POC_ANALYSIS.md)
- [Release](docs/RELEASE.md)
- [Android Distribution](docs/ANDROID_DISTRIBUTION.md)
- [Android Acceptance (Human)](docs/ANDROID_ACCEPTANCE.md)

## Release path

1. Android / Kindle実機でRelease Candidate品質を確認
2. CI/CDとRelease運用を確立
3. Android向け配布方式を確定
4. `v1.0.0-rc.N` を生成して公開前Acceptance
5. `v1.0.0` を一般公開

旧 `experimental` 側は移行元の履歴参照用として残し、新規開発PRはこのRepositoryで行います。
