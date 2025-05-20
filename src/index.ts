import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import {
  Room,
  RoomEvent,
  dispose,
  VideoStream,
  VideoFrame,
  AudioFrame,
  TrackKind,
  AudioStream,
} from "@livekit/rtc-node";
import stream from "node:stream";

import grandiose from "grandiose";

import { readFile } from "node:fs/promises";
import { select } from "@inquirer/prompts";
import { createSpinner } from "nanospinner";

const serversListTxt = await readFile("./servers.json", {
  encoding: "utf8",
});

const serversList = JSON.parse(serversListTxt) as Record<
  "NAME" | "LIVEKIT_URL" | "LIVEKIT_API_KEY" | "LIVEKIT_API_SECRET",
  string
>[];

const selectedServerName = await select({
  message: "Select server",
  choices: serversList.map((a) => {
    return { name: a.NAME, value: a.NAME };
  }),
});

const selectedServer = serversList.find((a) => a.NAME === selectedServerName);

if (selectedServer === undefined) {
  throw new Error("Invalid Server");
}

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = selectedServer;

const svc = new RoomServiceClient(
  LIVEKIT_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET
);

let rooms: Awaited<ReturnType<typeof svc.listRooms>> = [];

const spinner = createSpinner("Waiting for rooms").start();

while (rooms.length < 1) {
  rooms = await svc.listRooms([]);
  await new Promise((resolve) => {
    setTimeout(() => {
      resolve(null);
    }, 1000);
  });
}

spinner.success();

const roomName = await select({
  message: "Select room",
  choices: rooms.map((room) => ({
    name: room.name,
    value: room.name,
  })),
});

const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
at.identity = "NDI_ROBOT";

at.addGrant({ roomJoin: true, room: roomName });

const token = await at.toJwt();

const room = new Room();

await room.connect(LIVEKIT_URL, token, {
  autoSubscribe: true,
  dynacast: false,
});

const ndiSenderDict: Record<string, grandiose.Sender> = {};

room
  .on(RoomEvent.TrackSubscribed, async (track, publication, participant) => {
    if (ndiSenderDict[participant.identity] === undefined) {
      try {
        // .send() is incorrectly typed, it is a promise
        const ndiSender = await grandiose.send({
          name: `${participant.identity}`,
        });
        ndiSenderDict[participant.identity] = ndiSender;
      } catch (err) {
        console.error(
          `Failed to create NDI sender for ${participant.identity}`
        );
        console.error(err);
      }
    }

    if (track.sid === undefined) {
      return;
    }

    if (track.kind === TrackKind.KIND_VIDEO) {
      const videostream = stream.Readable.from(new VideoStream(track));

      videostream.on("close", () => {
        console.log(`video stream for ${participant.identity} is closed`);
      });

      videostream.on("end", () => {
        console.log(`video stream for ${participant.identity} ended`);
      });

      videostream.on(
        "data",
        (chunk: {
          frame: VideoFrame;
          timestampUs: BigInt;
          rotation: number;
        }) => {
          const VideoBufferTypeEnum = {
            0: grandiose.FourCC.RGBA,
            1: grandiose.FourCC.RGBA, //ABGR
            2: grandiose.FourCC.RGBA, //ARGB
            3: grandiose.FourCC.BGRA,
            4: grandiose.FourCC.RGBA, // RGB24
            5: grandiose.FourCC.I420,
            6: grandiose.FourCC.I420, // I420A
            7: grandiose.FourCC.I420, // I422
            8: grandiose.FourCC.I420, // I444
            9: grandiose.FourCC.I420, // I010
            10: grandiose.FourCC.NV12,
          };

          if ([1, 2, 4, 6, 7, 8, 9].includes(chunk.frame.type)) {
            console.warn(
              "Maybe unsupported frame fourcc type: ",
              chunk.frame.type
            );
          }

          if (typeof ndiSenderDict[participant.identity] !== "undefined") {
            ndiSenderDict[participant.identity].video({
              data: Buffer.from(chunk.frame.data),
              type: "video",
              fourCC: VideoBufferTypeEnum[chunk.frame.type],
              frameFormatType: grandiose.FrameType.Interlaced,
              frameRateD: 30000,
              frameRateN: 1001,
              xres: chunk.frame.width,
              yres: chunk.frame.height,
              timestamp: [Number(chunk.timestampUs), 0],
              timecode: [0, 0],
              pictureAspectRatio: chunk.frame.width / chunk.frame.height,
              lineStrideBytes: chunk.frame.width,
            });
          }
        }
      );
    } else if (track.kind === TrackKind.KIND_AUDIO) {
      const audiostream = stream.Readable.from(new AudioStream(track));

      audiostream.on("close", () => {
        console.log(`audio stream for ${participant.identity} is closed`);
      });

      audiostream.on("end", () => {
        console.log(`audio stream for ${participant.identity} ended`);
      });

      audiostream.on("data", (chunk: AudioFrame) => {
        const arrInt = new Int16Array(chunk.data);
        const arrFloat = new Float32Array(arrInt.length);

        for (let i = 0; i < arrInt.length; i++) {
          const limit = Math.pow(2, 16) - 1;
          arrFloat[i] =
            Math.max(-1 * limit, Math.min(limit, Number(arrInt[i]))) / limit;
        }

        const buffer = Buffer.alloc(4 * arrFloat.length);
        for (let i = 0; i < arrFloat.length; i++) {
          buffer.writeFloatLE(arrFloat[i], i * 4); // Little-endian format
        }

        if (typeof ndiSenderDict[participant.identity] !== "undefined") {
          ndiSenderDict[participant.identity].audio({
            sampleRate: chunk.sampleRate,
            channels: chunk.channels,
            data: buffer,
            samples: chunk.samplesPerChannel,
            channelStrideInBytes: 4,
            type: "audio",
          });
        }
      });
    }
  })
  .on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
    console.log(
      `UNSUBSCRIBE: ${participant.identity} | ${track.kind} | ${track.sid}`
    );
  })
  .on(RoomEvent.Disconnected, (reason) => {
    console.info("disconnected", reason);
  });

process.on("SIGINT", async () => {
  await room.disconnect();
  await dispose();
  process.exit();
});
