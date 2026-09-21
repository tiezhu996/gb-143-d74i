# 志愿者积分与信用评估

记录志愿服务、计算积分信用、处理投诉和生成排行榜的后端服务。

## 快速启动（Docker Compose）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：

- 前端：http://localhost:8243
- 后端健康检查：http://localhost:3243/api/health
- 数据库端口：localhost:5743

停止并清理容器、网络和数据卷：

```bash
docker compose down -v --remove-orphans
```

## 主要功能

- 志愿者档案与服务记录
- 积分、徽章和信用分计算
- 投诉处理、后台调整和排行榜
- 服务记录纠错闭环（志愿者发起、管理员审批，批准后原子重算积分/等级/徽章/信用分）

## 服务记录纠错闭环

- 志愿者只能对**本人**的服务记录提交纠错申请，说明更正确的时长、类型或评分（至少一项）及原因。
- 每条记录**终身只能提交一次**纠错申请，同一时间只允许存在一条待处理申请。
- 管理员**批准**后，系统按更正值重算该记录积分贡献，并在同一数据库事务内更新志愿者总积分、等级、徽章和信用分，同时写入积分明细、信用明细和后台审计日志。
- 管理员**驳回**后原记录与全部统计保持不变。
- 申请提交与审批均带行锁和唯一约束兜底：并发提交只产生一条申请，并发审批只生效一次；任何失败都会整体回滚，不留下半更新。

相关接口（均需认证，志愿者令牌为 `volunteer_<志愿者ID>`）：

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/v1/corrections/records/:recordId` | 志愿者 | 对指定记录提交纠错申请 |
| GET | `/api/v1/corrections` | 志愿者（仅本人）/ 管理员（全部，可按 `status`、`volunteer_id`、`record_id` 筛选） | 纠错申请列表 |
| GET | `/api/v1/corrections/:id` | 本人或管理员 | 纠错申请详情 |
| POST | `/api/v1/corrections/:id/handle` | 管理员 | `{"action":"approve"\|"reject","resolution":"..."}` |

普通服务记录导入、投诉处理和排行榜规则均不受影响。可运行 `npm run test:correction` 验证纠错闭环（含并发只生效一次、明细/排行榜一致性）。

## 本地开发

前端：

```bash
cd frontend
npm install
npm run dev
```

后端：

```bash
cd backend
npm install
npm run dev
```

数据库可通过根目录的 Docker Compose 单独启动：

```bash
docker compose up -d db
```

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端 | Static HTML + Nginx |
| 后端 | Express + TypeScript |
| 数据库 | PostgreSQL |
| 部署 | Docker Compose + Nginx |

## 项目目录结构

```text
.
├── docker-compose.yml
├── .env.example
├── .env
├── frontend/
│   ├── Dockerfile
│   ├── nginx.conf
│   └── ...
├── backend/
│   ├── Dockerfile
│   └── ...
└── database/
    └── ...
```

## 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| COMPOSE_PROJECT_NAME | Compose 项目名，避免中文目录名导致项目名为空 | gb-143 |
| DB_NAME | 数据库名称 | volunteer_db |
| DB_USER | 数据库用户 | volunteer_user |
| DB_PASSWORD | 数据库密码 | volunteer_pass |
| DB_ROOT_PASSWORD | 数据库 root/superuser 密码 | volunteer_root_pwd |
| JWT_SECRET | 后端签名密钥 | volunteer_credit_secret_key_2026 |
| FRONTEND_PORT | 前端宿主机端口 | 8243 |
| BACKEND_PORT | 后端宿主机端口 | 3243 |
| DB_PORT | 数据库宿主机端口 | 5743 |

## Docker 部署说明

- `docker-compose.yml` 顶层已声明 `name: gb-143`，可以在中文目录名下直接运行。
- 数据库使用 Docker 命名卷 `db_data` 持久化，不绑定到宿主中文路径。
- 前端容器使用 Nginx 托管静态资源，并将 `/api` 反向代理到后端服务名 `backend`。
- 后端会等待数据库健康后再启动，前端会等待后端健康后再启动。
- 如本机端口冲突，修改根目录 `.env` 中的 `FRONTEND_PORT`、`BACKEND_PORT` 或 `DB_PORT`。

## License

MIT
