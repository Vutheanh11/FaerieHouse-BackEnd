import { readFileSync } from "node:fs";

export const members2026 = JSON.parse(readFileSync(new URL("../data/members.json", import.meta.url), "utf8"));
export const posts = JSON.parse(readFileSync(new URL("../data/posts.json", import.meta.url), "utf8"));
export const popupConfig = JSON.parse(readFileSync(new URL("../data/popup.json", import.meta.url), "utf8"));

const event = ({ id, date, title, description, tag, location, tone, folder, photos }) => ({
  id,
  date,
  year: "2026",
  title,
  description,
  tag,
  location,
  tone,
  images: photos.map((photo) => `images/events/2026/${folder}/${photo}.webp`),
});

export const events2026 = [
  event({
    id: "2026-02-07-kick-off",
    date: "02.07",
    title: "Khởi động đội ngũ Faerie",
    description: "Cột mốc mở đầu hành trình Faerie 2026 — gặp gỡ đội ngũ điều hành, thống nhất tinh thần và cùng nhau viết chương đầu tiên.",
    tag: "Gặp gỡ đội ngũ",
    location: "FPTU TP.HCM",
    tone: "mint",
    folder: "kickoff",
    photos: ["KickOff2026", "KickOff2026_1", "KickOff2026_2", "KickOff2026_3", "KickOff2026_4", "KickOff2026_5", "KickOff2026_6"],
  }),
  event({
    id: "2026-15-07-hop-offline-lan-dau",
    date: "15.07",
    title: "Buổi họp trực tiếp đầu tiên",
    description: "Buổi gặp mặt trực tiếp đầu tiên của cả nhà, nơi những cái tên trên màn hình trở thành bạn bè và những kế hoạch bắt đầu thành hình.",
    tag: "Gặp gỡ",
    location: "TP.HCM",
    tone: "fern",
    folder: "offline",
    photos: ["HopOffline_1", "HopOffline_2", "HopOffline_3", "HopOffline_4", "HopOffline_5", "HopOffline_6", "HopOffline_7"],
  }),
  event({
    date: "16.08",
    title: "Team Building",
    description: "Một ngày cùng thử thách, phối hợp và kết nối để mỗi thành viên hiểu nhau hơn, đồng lòng hơn trên hành trình Faerie.",
    tag: "Kết nối",
    location: "TP.HCM",
    tone: "mint",
    folder: "team-building",
    photos: ["TeamBuilding_1", "TeamBuilding_2", "TeamBuilding_3", "TeamBuilding_4", "TeamBuilding_5", "TeamBuilding_6", "TeamBuilding_7", "TeamBuilding_8"],
  }),
  event({
    id: "2026-25-08-kick-off",
    date: "25.08",
    title: "Kick Off Faerie 2026",
    description: "Cột mốc khởi động chặng đường mới, nơi cả nhà cùng gặp gỡ, chia sẻ mục tiêu và sẵn sàng tạo nên những dấu ấn tiếp theo.",
    tag: "Kick Off",
    location: "FPTU TP.HCM",
    tone: "fern",
    folder: "kickoff-august",
    photos: ["KickOff_1", "KickOff_2", "KickOff_3", "KickOff_4", "KickOff_6"],
  }),
  event({
    id: "2026-02-09-chao-mung-quoc-khanh",
    date: "02.09",
    title: "Chào mừng Quốc khánh",
    description: "Faerie cùng hòa chung không khí Quốc khánh, lưu lại những khoảnh khắc rực rỡ và niềm tự hào trong sắc màu Việt Nam.",
    tag: "Quốc khánh",
    location: "FPTU TP.HCM",
    tone: "mint",
    folder: "national-day",
    photos: ["QK_1", "QK_2", "QK_3", "QK_4", "QK_5", "QK_6"],
  }),
  event({
    date: "03.09",
    title: "Welcome Day 1",
    description: "Ngày đầu tiên Faerie chào đón những gương mặt mới bằng năng lượng, nụ cười và những kết nối đầu tiên tại Đại học FPT TP.HCM.",
    tag: "Welcome Day",
    location: "FPTU TP.HCM",
    tone: "fern",
    folder: "welcome-day-1",
    photos: ["WD_1", "WD_2", "WD_3", "WD_4"],
  }),
  event({
    date: "04.09",
    title: "Welcome Day 2",
    description: "Welcome Day tiếp tục với thêm nhiều cuộc gặp gỡ, hoạt động và kỷ niệm, nối dài lời chào của nhà Faerie dành cho tân sinh viên.",
    tag: "Welcome Day",
    location: "FPTU TP.HCM",
    tone: "mint",
    folder: "welcome-day-2",
    photos: ["WD2_1", "WD2_2", "WD2_3", "WD2_4"],
  }),
];
